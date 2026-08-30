-- Stable, service-only retrieval contract. Rights and owner/global scope are
-- applied before vector ranking because the service role bypasses RLS.

create or replace function public.retrieve_conditioning_candidates_v1(
  p_profile_id uuid,
  p_query_embedding extensions.vector(768),
  p_embedding_model text,
  p_style_pack_id text default null,
  p_pool_size integer default 12,
  p_excluded_conditioning_hashes text[] default '{}'::text[]
)
returns table (
  asset_id uuid,
  owner_profile_id uuid,
  storage_bucket text,
  storage_path text,
  source text,
  style_pack_id text,
  description text,
  grade_notes text,
  tags text[],
  rights text,
  usable_for_conditioning boolean,
  content_sha256 text,
  conditioning_sha256 text,
  embedding_model text,
  indexing_version text,
  relevance double precision,
  visual_embedding text,
  source_priority integer
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if p_profile_id is null or p_query_embedding is null then
    raise exception 'profile_required' using errcode = '22023';
  end if;
  if p_embedding_model <> 'gemini-embedding-2' then
    raise exception 'embedding_model_mismatch' using errcode = '22023';
  end if;
  if p_pool_size <> 12 then
    raise exception 'retrieval_pool_size_is_server_owned' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_excluded_conditioning_hashes, '{}'::text[])) > 12
    or exists (
      select 1
      from unnest(coalesce(p_excluded_conditioning_hashes, '{}'::text[]))
        as excluded(value)
      where excluded.value !~ '^[a-f0-9]{64}$'
    ) then
    raise exception 'invalid_reference_exclusion_set' using errcode = '22023';
  end if;
  if p_style_pack_id is not null and (
    length(p_style_pack_id) < 1
    or length(p_style_pack_id) > 80
    or p_style_pack_id !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'
  ) then
    raise exception 'invalid_style_pack_id' using errcode = '22023';
  end if;

  return query
  with selected_pack as (
    select
      a.id as asset_id,
      a.profile_id as owner_profile_id,
      a.conditioning_storage_bucket as storage_bucket,
      a.conditioning_storage_path as storage_path,
      a.source,
      a.style_pack_id::text as style_pack_id,
      a.description,
      coalesce(a.grade_notes, '') as grade_notes,
      coalesce(a.tags, '{}'::text[]) as tags,
      a.rights,
      a.usable_for_conditioning,
      a.content_sha256,
      a.conditioning_sha256,
      a.embedding_model,
      a.indexing_version,
      1 - (a.embedding OPERATOR(extensions.<=>) p_query_embedding)
        as relevance,
      a.visual_embedding::text as visual_embedding,
      0::integer as source_priority,
      a.embedding OPERATOR(extensions.<=>) p_query_embedding as distance
    from public.inspiration_assets a
    where p_style_pack_id is not null
      and a.source = 'style_pack'
      and (a.profile_id is null or a.profile_id = p_profile_id)
      and a.style_pack_id::text = p_style_pack_id
      and a.usable_for_conditioning is true
      and a.rights in ('owned', 'licensed')
      and a.index_status = 'ready'
      and a.embedding_model = p_embedding_model
      and a.embedding is not null
      and a.visual_embedding is not null
      and a.content_sha256 ~ '^[a-f0-9]{64}$'
      and a.conditioning_sha256 ~ '^[a-f0-9]{64}$'
      and a.conditioning_storage_bucket = 'inspiration-conditioning'
      and a.conditioning_storage_path is not null
      and not (a.conditioning_sha256 = any(
        coalesce(p_excluded_conditioning_hashes, '{}'::text[])
      ))
    order by a.embedding OPERATOR(extensions.<=>) p_query_embedding,
      a.conditioning_sha256,
      a.id
    limit 12
  ),
  fallback as (
    select
      a.id as asset_id,
      a.profile_id as owner_profile_id,
      a.conditioning_storage_bucket as storage_bucket,
      a.conditioning_storage_path as storage_path,
      a.source,
      a.style_pack_id::text as style_pack_id,
      a.description,
      coalesce(a.grade_notes, '') as grade_notes,
      coalesce(a.tags, '{}'::text[]) as tags,
      a.rights,
      a.usable_for_conditioning,
      a.content_sha256,
      a.conditioning_sha256,
      a.embedding_model,
      a.indexing_version,
      1 - (a.embedding OPERATOR(extensions.<=>) p_query_embedding)
        as relevance,
      a.visual_embedding::text as visual_embedding,
      case
        when a.profile_id = p_profile_id and p_style_pack_id is null then 0
        when a.profile_id = p_profile_id then 1
        when p_style_pack_id is null then 1
        else 2
      end::integer as source_priority,
      a.embedding OPERATOR(extensions.<=>) p_query_embedding as distance
    from public.inspiration_assets a
    where (
        a.profile_id = p_profile_id
        or (a.source = 'style_pack' and a.profile_id is null)
      )
      and not (
        p_style_pack_id is not null
        and a.source = 'style_pack'
        and a.style_pack_id::text = p_style_pack_id
      )
      and a.source in ('user_upload', 'style_pack')
      and a.usable_for_conditioning is true
      and a.rights in ('owned', 'licensed')
      and a.index_status = 'ready'
      and a.embedding_model = p_embedding_model
      and a.embedding is not null
      and a.visual_embedding is not null
      and a.content_sha256 ~ '^[a-f0-9]{64}$'
      and a.conditioning_sha256 ~ '^[a-f0-9]{64}$'
      and a.conditioning_storage_bucket = 'inspiration-conditioning'
      and a.conditioning_storage_path is not null
      and not (a.conditioning_sha256 = any(
        coalesce(p_excluded_conditioning_hashes, '{}'::text[])
      ))
    order by a.embedding OPERATOR(extensions.<=>) p_query_embedding,
      a.conditioning_sha256,
      a.id
    limit 12
  ),
  combined as (
    select * from selected_pack
    union all
    select * from fallback
  )
  select
    c.asset_id,
    c.owner_profile_id,
    c.storage_bucket,
    c.storage_path,
    c.source,
    c.style_pack_id,
    c.description,
    c.grade_notes,
    c.tags,
    c.rights,
    c.usable_for_conditioning,
    c.content_sha256,
    c.conditioning_sha256,
    c.embedding_model,
    c.indexing_version,
    c.relevance,
    c.visual_embedding,
    c.source_priority
  from combined c
  order by c.source_priority, c.distance, c.conditioning_sha256, c.asset_id
  limit 12;
end;
$$;

create or replace function public.revalidate_conditioning_reference_v1(
  p_profile_id uuid,
  p_asset_id uuid,
  p_conditioning_sha256 text,
  p_embedding_model text
)
returns table (
  storage_bucket text,
  storage_path text,
  conditioning_sha256 text,
  rights text,
  source text
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    a.conditioning_storage_bucket,
    a.conditioning_storage_path,
    a.conditioning_sha256,
    a.rights,
    a.source
  from public.inspiration_assets a
  where a.id = p_asset_id
    and (
      a.profile_id = p_profile_id
      or (a.source = 'style_pack' and a.profile_id is null)
    )
    and a.source in ('user_upload', 'style_pack')
    and a.usable_for_conditioning is true
    and a.rights in ('owned', 'licensed')
    and a.index_status = 'ready'
    and a.embedding_model = p_embedding_model
    and a.conditioning_sha256 = p_conditioning_sha256
    and a.conditioning_storage_bucket = 'inspiration-conditioning'
    and a.conditioning_storage_path is not null
    and a.embedding is not null
    and a.visual_embedding is not null;
$$;

revoke all on function public.retrieve_conditioning_candidates_v1(
  uuid, extensions.vector, text, text, integer, text[]
) from public, anon, authenticated;
revoke all on function public.revalidate_conditioning_reference_v1(
  uuid, uuid, text, text
) from public, anon, authenticated;

grant execute on function public.retrieve_conditioning_candidates_v1(
  uuid, extensions.vector, text, text, integer, text[]
) to service_role;
grant execute on function public.revalidate_conditioning_reference_v1(
  uuid, uuid, text, text
) to service_role;

comment on function public.retrieve_conditioning_candidates_v1(
  uuid, extensions.vector, text, text, integer, text[]
) is 'Rights-first, owner/shared-scoped candidate pool for server-side MMR. Never expose this RPC to clients.';
