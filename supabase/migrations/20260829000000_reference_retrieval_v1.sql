-- ============================================================
-- GEMS — Rights-safe retrieval-conditioned reference library
-- ============================================================

begin;

create extension if not exists vector with schema extensions;

alter table public.inspiration_assets
  add column if not exists source text not null default 'user_upload',
  add column if not exists style_pack_id text,
  add column if not exists description text,
  add column if not exists scene_type text,
  add column if not exists time_of_day text,
  add column if not exists light text,
  add column if not exists palette text,
  add column if not exists subject_present boolean,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists grade_notes text,
  add column if not exists embedding extensions.vector(768),
  add column if not exists visual_embedding extensions.vector(768),
  add column if not exists embedding_model text,
  add column if not exists indexing_version text,
  add column if not exists index_status text not null default 'pending',
  add column if not exists index_error text,
  add column if not exists content_sha256 text,
  add column if not exists conditioning_sha256 text,
  add column if not exists rights text not null default 'unverified',
  add column if not exists usable_for_conditioning boolean not null default false,
  add column if not exists indexed_at timestamptz;

-- Shared style-pack rows are service-owned and are not tied to a deletable user
-- profile. Owner RLS still requires a non-null profile_id for user uploads.
alter table public.inspiration_assets alter column profile_id drop not null;

-- Existing rows predate an explicit rights decision and remain excluded.
update public.inspiration_assets
set rights = 'unverified', usable_for_conditioning = false
where rights is null or rights not in ('unverified', 'owned', 'licensed', 'pack');

create or replace function public.reference_tags_valid(p_tags text[])
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(cardinality(p_tags), 0) <= 32
    and not exists (
      select 1 from unnest(coalesce(p_tags, '{}'::text[])) as tag
      where char_length(tag) not between 1 and 80
    )
$$;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_source_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_source_check
  check (source in ('user_upload', 'style_pack', 'imported')) not valid;
alter table public.inspiration_assets validate constraint inspiration_assets_source_check;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_rights_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_rights_check
  check (rights in ('unverified', 'owned', 'licensed', 'pack')) not valid;
alter table public.inspiration_assets validate constraint inspiration_assets_rights_check;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_rights_gate_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_rights_gate_check
  check (
    not usable_for_conditioning
    or rights in ('owned', 'licensed')
  ) not valid;
alter table public.inspiration_assets validate constraint inspiration_assets_rights_gate_check;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_style_pack_shape_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_style_pack_shape_check
  check (
    (source = 'style_pack' and char_length(style_pack_id) between 1 and 80)
    or (source <> 'style_pack' and style_pack_id is null and profile_id is not null)
  ) not valid;
alter table public.inspiration_assets validate constraint inspiration_assets_style_pack_shape_check;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_index_status_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_index_status_check
  check (index_status in ('pending', 'indexing', 'ready', 'failed')) not valid;
alter table public.inspiration_assets validate constraint inspiration_assets_index_status_check;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_index_payload_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_index_payload_check
  check (
    char_length(coalesce(description, '')) <= 4000
    and char_length(coalesce(grade_notes, '')) <= 2000
    and char_length(coalesce(index_error, '')) <= 500
    and public.reference_tags_valid(tags)
    and (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$')
    and (conditioning_sha256 is null or conditioning_sha256 ~ '^[0-9a-f]{64}$')
    and (
      index_status <> 'ready'
      or (
        nullif(description, '') is not null
        and embedding is not null
        and visual_embedding is not null
        and nullif(embedding_model, '') is not null
        and nullif(indexing_version, '') is not null
        and content_sha256 is not null
        and conditioning_sha256 is not null
        and indexed_at is not null
      )
    )
  ) not valid;
alter table public.inspiration_assets validate constraint inspiration_assets_index_payload_check;

create index if not exists idx_inspiration_assets_retrieval_eligible
  on public.inspiration_assets (source, style_pack_id, rights, index_status)
  where usable_for_conditioning and index_status = 'ready';
create unique index if not exists inspiration_assets_shared_storage_unique
  on public.inspiration_assets (storage_path)
  where profile_id is null;

-- HNSW is safe to build before backfill and remains robust as a continuously
-- growing library changes distribution; an empty IVFFlat index does not.
create index if not exists idx_inspiration_assets_embedding_hnsw
  on public.inspiration_assets using hnsw (embedding extensions.vector_cosine_ops)
  where usable_for_conditioning and index_status = 'ready';
create index if not exists idx_inspiration_assets_visual_embedding_hnsw
  on public.inspiration_assets using hnsw (visual_embedding extensions.vector_cosine_ops)
  where usable_for_conditioning and index_status = 'ready';

-- Client uploads may create only identity/path metadata. Rights, source,
-- eligibility, descriptions, hashes, and embeddings are service-owned.
revoke insert on public.inspiration_assets from authenticated;
grant insert (profile_id, storage_path, label, mime_type, byte_size)
  on public.inspiration_assets to authenticated;

-- Server-internal candidate retrieval. Storage paths and vectors are never
-- exposed through a public endpoint; generate-scene consumes this RPC directly.
create or replace function public.match_conditioning_references(
  p_profile_id uuid,
  p_query_embedding extensions.vector(768),
  p_embedding_model text,
  p_style_pack_id text default null,
  p_pool_size integer default 12,
  p_exclude_ids uuid[] default '{}'::uuid[]
)
returns table (
  asset_id uuid,
  storage_path text,
  mime_type text,
  description text,
  tags text[],
  grade_notes text,
  source text,
  style_pack_id text,
  content_sha256 text,
  embedding_text text,
  visual_embedding_text text,
  cosine_distance double precision,
  pack_priority integer
)
language sql
stable
security definer
set search_path = pg_catalog, extensions
as $$
  with pack_matches as (
    select
      a.id as asset_id,
      a.storage_path,
      a.mime_type,
      a.description,
      a.tags,
      a.grade_notes,
      a.source,
      a.style_pack_id,
      a.content_sha256,
      a.embedding::text as embedding_text,
      a.visual_embedding::text as visual_embedding_text,
      (a.embedding <=> p_query_embedding)::double precision as cosine_distance,
      0 as pack_priority
    from public.inspiration_assets a
    where p_style_pack_id is not null
      and a.source = 'style_pack'
      and a.style_pack_id = p_style_pack_id
      and a.usable_for_conditioning
      and a.rights in ('owned', 'licensed')
      and a.index_status = 'ready'
      and a.embedding_model = p_embedding_model
      and a.embedding is not null
      and a.visual_embedding is not null
      and not (a.id = any(coalesce(p_exclude_ids, '{}'::uuid[])))
    order by a.embedding <=> p_query_embedding
    limit greatest(1, least(coalesce(p_pool_size, 12), 48))
  ),
  general_matches as (
    select
      a.id as asset_id,
      a.storage_path,
      a.mime_type,
      a.description,
      a.tags,
      a.grade_notes,
      a.source,
      a.style_pack_id,
      a.content_sha256,
      a.embedding::text as embedding_text,
      a.visual_embedding::text as visual_embedding_text,
      (a.embedding <=> p_query_embedding)::double precision as cosine_distance,
      1 as pack_priority
    from public.inspiration_assets a
    where (a.source = 'style_pack' or a.profile_id = p_profile_id)
      and not (
        p_style_pack_id is not null
        and a.source = 'style_pack'
        and a.style_pack_id = p_style_pack_id
      )
      and a.usable_for_conditioning
      and a.rights in ('owned', 'licensed')
      and a.index_status = 'ready'
      and a.embedding_model = p_embedding_model
      and a.embedding is not null
      and a.visual_embedding is not null
      and not (a.id = any(coalesce(p_exclude_ids, '{}'::uuid[])))
    order by a.embedding <=> p_query_embedding
    limit greatest(1, least(coalesce(p_pool_size, 12), 48))
  ),
  combined as (
    select * from pack_matches
    union all
    select * from general_matches
  )
  select
    combined.asset_id,
    combined.storage_path,
    combined.mime_type,
    combined.description,
    combined.tags,
    combined.grade_notes,
    combined.source,
    combined.style_pack_id,
    combined.content_sha256,
    combined.embedding_text,
    combined.visual_embedding_text,
    combined.cosine_distance,
    combined.pack_priority
  from combined
  order by combined.pack_priority, combined.cosine_distance, combined.asset_id
  limit greatest(1, least(coalesce(p_pool_size, 12), 48))
$$;

revoke all on function public.match_conditioning_references(
  uuid, extensions.vector, text, text, integer, uuid[]
) from public, anon, authenticated;
grant execute on function public.match_conditioning_references(
  uuid, extensions.vector, text, text, integer, uuid[]
) to service_role;

-- Safe shared catalog: authenticated clients may inspect licensed/owned style
-- metadata, but never raw storage paths or embeddings.
create or replace function public.list_shared_conditioning_reference_catalog(
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  asset_id uuid,
  label text,
  description text,
  tags text[],
  style_pack_id text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select a.id, a.label, a.description, a.tags, a.style_pack_id
  from public.inspiration_assets a
  where a.source = 'style_pack'
    and a.usable_for_conditioning
    and a.rights in ('owned', 'licensed')
    and a.index_status = 'ready'
  order by a.style_pack_id, a.created_at, a.id
  limit greatest(1, least(coalesce(p_limit, 100), 200))
  offset greatest(0, coalesce(p_offset, 0))
$$;
revoke all on function public.list_shared_conditioning_reference_catalog(integer, integer)
  from public, anon;
grant execute on function public.list_shared_conditioning_reference_catalog(integer, integer)
  to authenticated, service_role;

-- Immutable provider-call cost ledger. Values are pricing snapshots in micro-USD
-- so tiny embedding calls do not round down to zero cents.
create table public.ai_provider_cost_events (
  id                       uuid primary key default gen_random_uuid(),
  profile_id               uuid references public.profiles (id) on delete cascade,
  event_key                text not null unique,
  operation                text not null,
  provider                 text not null,
  model_ref                text not null,
  provider_request_id      text,
  status                   text not null check (status in ('succeeded', 'rejected', 'failed', 'indeterminate')),
  input_units              bigint check (input_units is null or input_units >= 0),
  output_units             bigint check (output_units is null or output_units >= 0),
  image_count              integer check (image_count is null or image_count >= 0),
  estimated_cost_microusd  numeric(20, 6) not null default 0 check (estimated_cost_microusd >= 0),
  pricing_version          text not null,
  usage                    jsonb not null default '{}'::jsonb
                           check (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 16384),
  created_at               timestamptz not null default now()
);
alter table public.ai_provider_cost_events enable row level security;
create policy "ai_provider_cost_events: owner read"
  on public.ai_provider_cost_events for select to authenticated
  using ((select auth.uid()) = profile_id);
revoke all on public.ai_provider_cost_events from anon, authenticated;
grant select on public.ai_provider_cost_events to authenticated;
create index idx_ai_provider_cost_events_profile_created
  on public.ai_provider_cost_events (profile_id, created_at desc);
create index idx_ai_provider_cost_events_operation_created
  on public.ai_provider_cost_events (operation, created_at desc);

create or replace function public.record_ai_provider_cost_event(
  p_profile_id uuid,
  p_event_key text,
  p_operation text,
  p_provider text,
  p_model_ref text,
  p_provider_request_id text,
  p_status text,
  p_input_units bigint,
  p_output_units bigint,
  p_image_count integer,
  p_estimated_cost_microusd numeric,
  p_pricing_version text,
  p_usage jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_id uuid;
begin
  if char_length(coalesce(p_event_key, '')) not between 8 and 200
    or char_length(coalesce(p_operation, '')) not between 1 and 80
    or char_length(coalesce(p_provider, '')) not between 1 and 80
    or char_length(coalesce(p_model_ref, '')) not between 1 and 200
    or p_status not in ('succeeded', 'rejected', 'failed', 'indeterminate')
    or p_estimated_cost_microusd is null or p_estimated_cost_microusd < 0
    or char_length(coalesce(p_pricing_version, '')) not between 1 and 120
    or p_usage is null or jsonb_typeof(p_usage) <> 'object'
    or octet_length(p_usage::text) > 16384 then
    raise exception using errcode = '22023', message = 'ai_cost_event_invalid';
  end if;

  insert into public.ai_provider_cost_events (
    profile_id, event_key, operation, provider, model_ref,
    provider_request_id, status, input_units, output_units, image_count,
    estimated_cost_microusd, pricing_version, usage
  ) values (
    p_profile_id, p_event_key, p_operation, p_provider, p_model_ref,
    left(p_provider_request_id, 200), p_status, p_input_units, p_output_units,
    p_image_count, p_estimated_cost_microusd, p_pricing_version, p_usage
  )
  on conflict (event_key) do nothing
  returning id into v_id;

  if v_id is null then
    select e.id into v_id
    from public.ai_provider_cost_events e
    where e.event_key = p_event_key;
  end if;
  return v_id;
end;
$$;

revoke all on function public.record_ai_provider_cost_event(
  uuid, text, text, text, text, text, text, bigint, bigint, integer,
  numeric, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_ai_provider_cost_event(
  uuid, text, text, text, text, text, text, bigint, bigint, integer,
  numeric, text, jsonb
) to service_role;

commit;
