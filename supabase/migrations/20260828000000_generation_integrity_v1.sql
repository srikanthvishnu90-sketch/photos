-- ============================================================
-- GEMS — Generation Integrity v1
-- Durable scene jobs, atomic monthly credits, recoverable output,
-- immutable provenance, and private deterministic storage paths.
-- ============================================================

begin;

-- Scenes were added after the original projects checks were committed.
alter table public.projects drop constraint if exists projects_kind_check;
alter table public.projects
  add constraint projects_kind_check
  check (kind in ('dump', 'edit', 'template', 'moodboard', 'scene')) not valid;
alter table public.projects validate constraint projects_kind_check;

alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects
  add constraint projects_status_check
  check (status in ('draft', 'ready', 'exported', 'archived')) not valid;
alter table public.projects validate constraint projects_status_check;

-- Composite ownership FKs below need a stable unique target. Do not drop an
-- equivalent constraint if a partially provisioned environment already has it.
do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.projects'::regclass
      and conname = 'projects_id_profile_unique'
  ) then
    alter table public.projects
      add constraint projects_id_profile_unique unique (id, profile_id);
  end if;
end;
$migration$;

-- Generated-scene project provenance is immutable from the client. Deletion
-- must use a server path that can remove the Storage object first.
create or replace function public.guard_generated_scene_projects()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.kind = 'scene'
    and coalesce(auth.role(), '') <> 'service_role'
    and current_user not in ('postgres', 'supabase_admin', 'supabase_auth_admin') then
    raise exception using errcode = '42501', message = 'scene_project_is_server_owned';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_projects_guard_generated_scene on public.projects;
create trigger trg_projects_guard_generated_scene
  before update or delete on public.projects
  for each row execute function public.guard_generated_scene_projects();

-- Billing state is server-owned. The original owner-update policy otherwise
-- lets a client promote its own profile from free to plus.
create or replace function public.guard_server_owned_profile_fields()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.plan is distinct from old.plan
    and coalesce(auth.role(), '') <> 'service_role'
    and current_user not in ('postgres', 'supabase_admin', 'supabase_auth_admin') then
    raise exception using errcode = '42501', message = 'profile_plan_is_server_owned';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard_server_owned on public.profiles;
create trigger trg_profiles_guard_server_owned
  before update on public.profiles
  for each row execute function public.guard_server_owned_profile_fields();

revoke update on public.profiles from authenticated;
grant update (display_name, gender, age_range, updated_at)
  on public.profiles to authenticated;

-- User-owned conditioning references. Pixels stay in the private inspiration
-- bucket; this table contains only an owner-scoped storage reference.
create table if not exists public.inspiration_assets (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  storage_path  text not null,
  label         text not null default '',
  mime_type     text,
  byte_size     bigint,
  created_at    timestamptz not null default now()
);

-- Reconcile constraints/indexes even when the table was provisioned manually.
alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_storage_path_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_storage_path_check
  check (storage_path like (profile_id::text || '/%')) not valid;
alter table public.inspiration_assets
  validate constraint inspiration_assets_storage_path_check;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_label_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_label_check
  check (char_length(label) <= 80) not valid;
alter table public.inspiration_assets
  validate constraint inspiration_assets_label_check;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_byte_size_check;
alter table public.inspiration_assets
  add constraint inspiration_assets_byte_size_check
  check (byte_size is null or byte_size >= 0) not valid;
alter table public.inspiration_assets
  validate constraint inspiration_assets_byte_size_check;

create unique index if not exists inspiration_assets_profile_storage_unique
  on public.inspiration_assets (profile_id, storage_path);
create index if not exists idx_inspiration_assets_profile_created
  on public.inspiration_assets (profile_id, created_at desc);

alter table public.inspiration_assets enable row level security;
drop policy if exists "inspiration_assets: owner all" on public.inspiration_assets;
drop policy if exists "inspiration_assets: owner read" on public.inspiration_assets;
drop policy if exists "inspiration_assets: owner insert" on public.inspiration_assets;
drop policy if exists "inspiration_assets: owner update label" on public.inspiration_assets;
drop policy if exists "inspiration_assets: owner delete" on public.inspiration_assets;
create policy "inspiration_assets: owner read" on public.inspiration_assets
  for select to authenticated using ((select auth.uid()) = profile_id);
create policy "inspiration_assets: owner insert" on public.inspiration_assets
  for insert to authenticated with check ((select auth.uid()) = profile_id);
create policy "inspiration_assets: owner update label" on public.inspiration_assets
  for update to authenticated
  using ((select auth.uid()) = profile_id)
  with check ((select auth.uid()) = profile_id);
create policy "inspiration_assets: owner delete" on public.inspiration_assets
  for delete to authenticated using ((select auth.uid()) = profile_id);

revoke all on public.inspiration_assets from anon;
grant select, insert, delete on public.inspiration_assets to authenticated;
revoke update on public.inspiration_assets from authenticated;
grant update (label) on public.inspiration_assets to authenticated;

-- PostgreSQL jsonb text is the canonical representation used for request
-- identity. Callers submit the manifest, never an independently trusted hash.
create or replace function public.scene_manifest_sha256(p_manifest jsonb)
returns text
language sql
immutable
strict
set search_path = pg_catalog, extensions, public
as $$
  select encode(digest(convert_to(p_manifest::text, 'UTF8'), 'sha256'), 'hex')
$$;

-- One job owns exactly one possible output object. The extension is derived
-- from the verified response MIME type; random per-attempt paths are forbidden.
create or replace function public.scene_output_storage_path(
  p_profile_id uuid,
  p_job_id uuid,
  p_mime_type text
)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select p_profile_id::text || '/scene/' || p_job_id::text || '/output.' ||
    case p_mime_type
      when 'image/jpeg' then 'jpg'
      when 'image/png' then 'png'
      when 'image/webp' then 'webp'
      else 'invalid'
    end
$$;

create or replace function public.scene_output_storage_paths(
  p_profile_id uuid,
  p_job_id uuid
)
returns text[]
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select array[
    public.scene_output_storage_path(p_profile_id, p_job_id, 'image/jpeg'),
    public.scene_output_storage_path(p_profile_id, p_job_id, 'image/png'),
    public.scene_output_storage_path(p_profile_id, p_job_id, 'image/webp')
  ]::text[]
$$;

create table public.generation_jobs (
  id                       uuid primary key default gen_random_uuid(),
  profile_id               uuid not null references public.profiles (id) on delete cascade,
  project_id               uuid,
  idempotency_key          text not null,
  batch_id                 text not null,
  request_manifest         jsonb not null,
  request_hash             text not null,
  status                   text not null default 'reserved',
  mode                     text not null,
  quality                  text not null,
  provider                 text not null,
  model_ref                text not null,
  prompt_version           text not null,
  units                    integer not null,
  error_code               text,
  error_detail             text,
  cancel_requested_at      timestamptz,
  reservation_expires_at   timestamptz not null,
  active_attempt_id        uuid,
  lease_token              uuid,
  lease_expires_at         timestamptz,
  pending_storage_bucket   text,
  pending_storage_path     text,
  pending_mime_type        text,
  pending_width            integer,
  pending_height           integer,
  pending_content_sha256   text,
  provider_response_id     text,
  provider_completed_at    timestamptz,
  output_recorded_at       timestamptz,
  finalization_payload     jsonb,
  cleanup_required_at      timestamptz,
  cleanup_not_before       timestamptz,
  cleanup_completed_at     timestamptz,
  started_at               timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint generation_jobs_idempotency_length_check
    check (char_length(idempotency_key) between 8 and 128),
  constraint generation_jobs_batch_length_check
    check (char_length(batch_id) between 8 and 128),
  constraint generation_jobs_request_manifest_check
    check (
      jsonb_typeof(request_manifest) = 'object'
      and request_manifest ->> 'schema' = 'scene-request-v1'
      and request_manifest ->> 'mode' = mode
      and request_manifest ->> 'quality' = quality
      and request_manifest ->> 'provider' = provider
      and request_manifest ->> 'model_ref' = model_ref
      and request_manifest ->> 'prompt_version' = prompt_version
      and request_manifest ->> 'units' = units::text
      and octet_length(request_manifest::text) <= 65536
    ),
  constraint generation_jobs_request_hash_check
    check (
      request_hash ~ '^[0-9a-f]{64}$'
      and request_hash = public.scene_manifest_sha256(request_manifest)
    ),
  constraint generation_jobs_status_check
    check (status in (
      'reserved', 'generating', 'output_pending', 'succeeded',
      'failed', 'canceled', 'indeterminate'
    )),
  constraint generation_jobs_mode_check
    check (mode in ('me', 'background')),
  constraint generation_jobs_quality_check
    check (quality in ('standard', 'pro')),
  constraint generation_jobs_provider_fields_check
    check (
      char_length(provider) between 1 and 80
      and char_length(model_ref) between 1 and 200
      and char_length(prompt_version) between 1 and 120
    ),
  constraint generation_jobs_units_check
    check (units = case quality when 'standard' then 1 when 'pro' then 3 end),
  constraint generation_jobs_pending_output_shape_check
    check (
      (
        pending_storage_bucket is null
        and pending_storage_path is null
        and pending_mime_type is null
        and pending_width is null
        and pending_height is null
        and pending_content_sha256 is null
        and provider_completed_at is null
        and output_recorded_at is null
        and finalization_payload is null
      )
      or
      (
        pending_storage_bucket = 'edits'
        and pending_mime_type in ('image/jpeg', 'image/png', 'image/webp')
        and pending_storage_path = public.scene_output_storage_path(
          profile_id, id, pending_mime_type
        )
        and pending_width > 0
        and pending_height > 0
        and pending_content_sha256 ~ '^[0-9a-f]{64}$'
        and provider_completed_at is not null
        and output_recorded_at is not null
        and jsonb_typeof(finalization_payload) = 'object'
      )
    ),
  constraint generation_jobs_state_shape_check
    check (
      (status <> 'reserved' or (
        active_attempt_id is null and lease_token is null
        and lease_expires_at is null and completed_at is null
      ))
      and (status <> 'generating' or (
        active_attempt_id is not null and lease_token is not null
        and lease_expires_at is not null and completed_at is null
      ))
      and (status <> 'output_pending' or (
        active_attempt_id is not null and lease_token is not null
        and lease_expires_at is null and pending_storage_path is not null
        and completed_at is null
      ))
      and (status <> 'succeeded' or (
        project_id is not null and pending_storage_path is not null
        and completed_at is not null and cleanup_required_at is null
        and cleanup_not_before is null
      ))
      and (status not in ('failed', 'canceled', 'indeterminate')
        or completed_at is not null)
      and (
        (cleanup_required_at is null and cleanup_not_before is null)
        or (cleanup_required_at is not null and cleanup_not_before is not null)
      )
    ),
  unique (profile_id, idempotency_key),
  unique (id, profile_id)
);

alter table public.generation_jobs
  add constraint generation_jobs_project_owner_fk
  foreign key (project_id, profile_id)
  references public.projects (id, profile_id) on delete cascade;

alter table public.generation_jobs enable row level security;
create policy "generation_jobs: owner read" on public.generation_jobs
  for select to authenticated using ((select auth.uid()) = profile_id);
create index idx_generation_jobs_profile_created
  on public.generation_jobs (profile_id, created_at desc);
create index idx_generation_jobs_batch
  on public.generation_jobs (profile_id, batch_id, created_at);
create index idx_generation_jobs_active
  on public.generation_jobs (profile_id, status, reservation_expires_at, lease_expires_at)
  where status in ('reserved', 'generating', 'output_pending', 'indeterminate');
create index idx_generation_jobs_cleanup
  on public.generation_jobs (cleanup_required_at)
  where cleanup_required_at is not null;

create trigger trg_generation_jobs_touch
  before update on public.generation_jobs
  for each row execute function public.touch_updated_at();

create table public.generation_attempts (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null,
  profile_id          uuid not null,
  attempt_number      smallint not null check (attempt_number > 0),
  lease_token         uuid not null unique,
  lease_expires_at    timestamptz not null,
  status              text not null default 'started'
                      check (status in (
                        'started', 'output_recorded', 'succeeded',
                        'failed', 'canceled', 'indeterminate'
                      )),
  provider            text not null,
  model_ref           text not null,
  provider_request_id text,
  latency_ms          integer check (latency_ms is null or latency_ms >= 0),
  error_code          text,
  error_detail        text,
  meta                jsonb not null default '{}'::jsonb
                      check (jsonb_typeof(meta) = 'object' and octet_length(meta::text) <= 32768),
  started_at          timestamptz not null default now(),
  completed_at        timestamptz,
  constraint generation_attempts_completion_check check (
    (status in ('started', 'output_recorded') and completed_at is null)
    or (status in ('succeeded', 'failed', 'canceled', 'indeterminate') and completed_at is not null)
  ),
  unique (job_id, attempt_number),
  unique (id, profile_id)
);

alter table public.generation_attempts
  add constraint generation_attempts_job_owner_fk
  foreign key (job_id, profile_id)
  references public.generation_jobs (id, profile_id) on delete cascade;
create unique index generation_attempts_one_active
  on public.generation_attempts (job_id)
  where status in ('started', 'output_recorded');
alter table public.generation_jobs
  add constraint generation_jobs_active_attempt_fk
  foreign key (active_attempt_id)
  references public.generation_attempts (id)
  deferrable initially deferred;

alter table public.generation_attempts enable row level security;
create policy "generation_attempts: owner read" on public.generation_attempts
  for select to authenticated using ((select auth.uid()) = profile_id);
create index idx_generation_attempts_job
  on public.generation_attempts (job_id, attempt_number);

create table public.credit_reservations (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null unique,
  profile_id    uuid not null,
  period_start  date not null,
  units         integer not null check (units in (1, 3)),
  status        text not null default 'reserved'
                check (status in ('reserved', 'consumed', 'released')),
  created_at    timestamptz not null default now(),
  finalized_at  timestamptz,
  constraint credit_reservations_finalization_check check (
    (status = 'reserved' and finalized_at is null)
    or (status in ('consumed', 'released') and finalized_at is not null)
  )
);

alter table public.credit_reservations
  add constraint credit_reservations_job_owner_fk
  foreign key (job_id, profile_id)
  references public.generation_jobs (id, profile_id) on delete cascade;

alter table public.credit_reservations enable row level security;
create policy "credit_reservations: owner read" on public.credit_reservations
  for select to authenticated using ((select auth.uid()) = profile_id);
create index idx_credit_reservations_month
  on public.credit_reservations (profile_id, period_start, status);

create table public.generated_assets (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null unique,
  project_id      uuid not null,
  profile_id      uuid not null,
  storage_bucket  text not null default 'edits' check (storage_bucket = 'edits'),
  storage_path    text not null,
  mime_type       text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  width           integer not null check (width > 0),
  height          integer not null check (height > 0),
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  ai_generated    boolean not null default true check (ai_generated),
  provenance      jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_at      timestamptz not null default now(),
  constraint generated_assets_deterministic_path_check check (
    storage_path = public.scene_output_storage_path(profile_id, job_id, mime_type)
  ),
  unique (profile_id, storage_bucket, storage_path),
  unique (id, job_id, profile_id)
);

alter table public.generated_assets
  add constraint generated_assets_job_owner_fk
  foreign key (job_id, profile_id)
  references public.generation_jobs (id, profile_id) on delete cascade;
alter table public.generated_assets
  add constraint generated_assets_project_owner_fk
  foreign key (project_id, profile_id)
  references public.projects (id, profile_id) on delete cascade;

alter table public.generated_assets enable row level security;
create policy "generated_assets: owner read" on public.generated_assets
  for select to authenticated using ((select auth.uid()) = profile_id);
create index idx_generated_assets_profile_created
  on public.generated_assets (profile_id, created_at desc);

-- Append-only, versioned evaluation labels for the generated asset. `distance`
-- is explicitly lower-is-better; SQL derives passed so labels cannot disagree
-- with their recorded threshold.
create table public.generation_identity_evaluations (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null,
  profile_id        uuid not null,
  asset_id          uuid not null,
  evaluator_version text not null
                    check (char_length(evaluator_version) between 1 and 120),
  distance          numeric not null check (distance >= 0 and distance <= 1000000),
  threshold         numeric not null check (threshold > 0 and threshold <= 1000000),
  passed            boolean not null,
  created_at        timestamptz not null default now(),
  constraint generation_identity_evaluations_result_check
    check (passed = (distance <= threshold)),
  constraint generation_identity_evaluations_job_version_unique
    unique (job_id, evaluator_version)
);

alter table public.generation_identity_evaluations
  add constraint generation_identity_evaluations_job_owner_fk
  foreign key (job_id, profile_id)
  references public.generation_jobs (id, profile_id) on delete cascade;
alter table public.generation_identity_evaluations
  add constraint generation_identity_evaluations_asset_job_owner_fk
  foreign key (asset_id, job_id, profile_id)
  references public.generated_assets (id, job_id, profile_id) on delete cascade;

alter table public.generation_identity_evaluations enable row level security;
create policy "generation_identity_evaluations: owner read"
  on public.generation_identity_evaluations
  for select to authenticated using ((select auth.uid()) = profile_id);
create index idx_generation_identity_evaluations_profile_created
  on public.generation_identity_evaluations (profile_id, created_at desc);

-- Job/attempt/credit/provenance rows are client-readable through RLS but only
-- the service role may mutate them.
revoke all on public.generation_jobs from anon, authenticated;
revoke all on public.generation_attempts from anon, authenticated;
revoke all on public.credit_reservations from anon, authenticated;
revoke all on public.generated_assets from anon, authenticated;
revoke all on public.generation_identity_evaluations from anon, authenticated;
grant select on public.generation_jobs to authenticated;
grant select on public.generation_attempts to authenticated;
grant select on public.credit_reservations to authenticated;
grant select on public.generated_assets to authenticated;
grant select on public.generation_identity_evaluations to authenticated;

-- Private buckets are part of the reproducible schema, not dashboard-only state.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('edits', 'edits', false, 26214400, array['image/jpeg', 'image/png', 'image/webp']),
  ('inspiration', 'inspiration', false, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Inspiration uploads are client-owned. The reserved _global prefix is not a
-- UUID and therefore remains service-role/admin only.
drop policy if exists "inspiration objects: owner read" on storage.objects;
create policy "inspiration objects: owner read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'inspiration'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "inspiration objects: owner insert" on storage.objects;
create policy "inspiration objects: owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'inspiration'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "inspiration objects: owner update" on storage.objects;
-- Conditioning objects are append-only at a path. Replacing bytes behind an
-- existing inspiration_assets id would invalidate request hashes/provenance;
-- users must delete the row/object and upload a new UUID path instead.
drop policy if exists "inspiration objects: owner delete" on storage.objects;
create policy "inspiration objects: owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'inspiration'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "edit objects: owner read" on storage.objects;
create policy "edit objects: owner read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'edits'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Remove obsolete overloads if this migration is repairing a partially
-- provisioned environment. The canonical contract accepts a manifest, not a
-- caller-computed hash or caller-selectable quota limits.
drop function if exists public.reserve_scene_generation(
  uuid, text, text, text, integer, text, text, text, text, text,
  integer, integer, integer
);

-- Atomically replay a request or reserve monthly units. Monthly policy is
-- intentionally server-owned: free=30 units, plus=300 units, batch=10 jobs;
-- standard costs 1 unit and pro costs 3 units.
create or replace function public.reserve_scene_generation(
  p_profile_id uuid,
  p_idempotency_key text,
  p_batch_id text,
  p_request_manifest jsonb,
  p_units integer,
  p_mode text,
  p_quality text,
  p_provider text,
  p_model_ref text,
  p_prompt_version text
)
returns table (
  job_id uuid,
  job_status text,
  replayed boolean,
  canonical_request_hash text,
  project_id uuid,
  storage_bucket text,
  storage_path text,
  mime_type text,
  attempt_id uuid,
  lease_token uuid,
  cleanup_required boolean,
  cleanup_paths text[],
  cleanup_not_before timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_existing public.generation_jobs%rowtype;
  v_job_id uuid;
  v_request_hash text;
  v_period_start date := date_trunc('month', timezone('UTC', now()))::date;
  v_plan text;
  v_cap integer;
  v_used integer;
  v_batch_count integer;
  v_active_count integer;
begin
  if p_idempotency_key is null
    or char_length(p_idempotency_key) not between 8 and 128
    or p_batch_id is null
    or char_length(p_batch_id) not between 8 and 128
    or p_request_manifest is null
    or jsonb_typeof(p_request_manifest) <> 'object'
    or p_request_manifest ->> 'schema' <> 'scene-request-v1'
    or octet_length(p_request_manifest::text) > 65536
    or p_units is null
    or p_mode is null
    or p_quality is null
    or p_provider is null
    or p_model_ref is null
    or p_prompt_version is null
    or p_units <> (case p_quality when 'standard' then 1 when 'pro' then 3 else -1 end)
    or p_mode not in ('me', 'background')
    or char_length(p_provider) not between 1 and 80
    or char_length(p_model_ref) not between 1 and 200
    or char_length(p_prompt_version) not between 1 and 120
    or (p_request_manifest ->> 'mode') is distinct from p_mode
    or (p_request_manifest ->> 'quality') is distinct from p_quality
    or (p_request_manifest ->> 'provider') is distinct from p_provider
    or (p_request_manifest ->> 'model_ref') is distinct from p_model_ref
    or (p_request_manifest ->> 'prompt_version') is distinct from p_prompt_version
    or (p_request_manifest ->> 'units') is distinct from p_units::text then
    raise exception using errcode = '22023', message = 'scene_reservation_invalid';
  end if;

  v_request_hash := public.scene_manifest_sha256(p_request_manifest);
  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  -- A reservation that never acquired a worker releases quota.
  update public.credit_reservations r
  set status = 'released', finalized_at = now()
  from public.generation_jobs j
  where r.job_id = j.id
    and j.profile_id = p_profile_id
    and j.status = 'reserved'
    and j.reservation_expires_at < now()
    and r.status = 'reserved';

  update public.generation_jobs j
  set status = 'failed',
      error_code = 'generation_reservation_expired',
      error_detail = 'No worker claimed the reserved generation job.',
      completed_at = now()
  where j.profile_id = p_profile_id
    and j.status = 'reserved'
    and j.reservation_expires_at < now();

  -- Once a provider-capable worker has claimed a job, expiration cannot prove
  -- the provider did no work. Preserve its lease capability for deterministic
  -- object recovery, mark the attempt indeterminate, and consume the units.
  update public.generation_attempts a
  set status = 'indeterminate',
      error_code = 'generation_lease_expired',
      error_detail = 'Worker lease expired; deterministic output recovery is required.',
      completed_at = now()
  from public.generation_jobs j
  where a.id = j.active_attempt_id
    and j.profile_id = p_profile_id
    and j.status = 'generating'
    and j.lease_expires_at < now()
    and a.status = 'started';

  update public.credit_reservations r
  set status = 'consumed', finalized_at = now()
  from public.generation_jobs j
  where r.job_id = j.id
    and j.profile_id = p_profile_id
    and j.status = 'generating'
    and j.lease_expires_at < now()
    and r.status = 'reserved';

  update public.generation_jobs j
  set status = 'indeterminate',
      error_code = 'generation_lease_expired',
      error_detail = 'Worker lease expired; deterministic output recovery is required.',
      lease_expires_at = null,
      completed_at = now()
  where j.profile_id = p_profile_id
    and j.status = 'generating'
    and j.lease_expires_at < now();

  select j.* into v_existing
  from public.generation_jobs j
  where j.profile_id = p_profile_id
    and j.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_hash <> v_request_hash
      or v_existing.request_manifest <> p_request_manifest
      or v_existing.batch_id <> p_batch_id
      or v_existing.units <> p_units
      or v_existing.mode <> p_mode
      or v_existing.quality <> p_quality
      or v_existing.provider <> p_provider
      or v_existing.model_ref <> p_model_ref
      or v_existing.prompt_version <> p_prompt_version then
      raise exception using errcode = '22023', message = 'scene_idempotency_conflict';
    end if;

    return query
      select
        v_existing.id,
        v_existing.status,
        true,
        v_existing.request_hash,
        v_existing.project_id,
        coalesce(a.storage_bucket, v_existing.pending_storage_bucket),
        coalesce(a.storage_path, v_existing.pending_storage_path),
        coalesce(a.mime_type, v_existing.pending_mime_type),
        v_existing.active_attempt_id,
        v_existing.lease_token,
        v_existing.cleanup_required_at is not null,
        case
          when v_existing.cleanup_required_at is not null
            then public.scene_output_storage_paths(v_existing.profile_id, v_existing.id)
          else array[]::text[]
        end,
        v_existing.cleanup_not_before
      from (select 1) as singleton
      left join public.generated_assets a on a.job_id = v_existing.id;
    return;
  end if;

  select p.plan into v_plan
  from public.profiles p
  where p.id = p_profile_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'scene_profile_missing';
  end if;
  v_cap := case when v_plan = 'plus' then 300 else 30 end;

  select count(*)::integer into v_batch_count
  from public.generation_jobs j
  where j.profile_id = p_profile_id
    and j.batch_id = p_batch_id;
  if v_batch_count >= 10 then
    raise exception using errcode = 'P0001', message = 'scene_batch_limit';
  end if;

  select count(*)::integer into v_active_count
  from public.generation_jobs j
  where j.profile_id = p_profile_id
    and j.status in ('reserved', 'generating', 'output_pending');
  if v_active_count >= 3 then
    raise exception using errcode = 'P0001', message = 'scene_concurrency_limit';
  end if;

  select coalesce(sum(r.units), 0)::integer into v_used
  from public.credit_reservations r
  where r.profile_id = p_profile_id
    and r.period_start = v_period_start
    and r.status in ('reserved', 'consumed');
  if v_used + p_units > v_cap then
    raise exception using errcode = 'P0001', message = 'scene_quota_exceeded';
  end if;

  insert into public.generation_jobs (
    profile_id, idempotency_key, batch_id, request_manifest, request_hash,
    status, mode, quality, provider, model_ref, prompt_version, units,
    reservation_expires_at
  ) values (
    p_profile_id, p_idempotency_key, p_batch_id, p_request_manifest,
    v_request_hash, 'reserved', p_mode, p_quality, p_provider, p_model_ref,
    p_prompt_version, p_units, now() + interval '10 minutes'
  ) returning id into v_job_id;

  insert into public.credit_reservations (
    job_id, profile_id, period_start, units
  ) values (
    v_job_id, p_profile_id, v_period_start, p_units
  );

  return query select
    v_job_id,
    'reserved'::text,
    false,
    v_request_hash,
    null::uuid,
    null::text,
    null::text,
    null::text,
    null::uuid,
    null::uuid,
    false,
    array[]::text[],
    null::timestamptz;
end;
$$;

-- Exclusive worker claim. A caller may invoke the provider only when claimed
-- is true. Unexpired duplicate claims receive the same attempt with false;
-- expired claims become indeterminate and are never silently retried.
create or replace function public.start_scene_generation(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_meta jsonb default '{}'::jsonb
)
returns table (
  attempt_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  claimed boolean,
  job_status text
)
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_attempt_id uuid;
  v_lease_token uuid;
  v_lease_expires_at timestamptz;
  v_attempt_number smallint;
begin
  if p_attempt_meta is null
    or jsonb_typeof(p_attempt_meta) <> 'object'
    or octet_length(p_attempt_meta::text) > 16384 then
    raise exception using errcode = '22023', message = 'scene_attempt_meta_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select j.* into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'scene_job_missing';
  end if;

  if v_job.status = 'generating' and v_job.lease_expires_at < now() then
    update public.generation_attempts a
    set status = 'indeterminate',
        error_code = 'generation_lease_expired',
        error_detail = 'Worker lease expired; deterministic output recovery is required.',
        completed_at = now()
    where a.id = v_job.active_attempt_id
      and a.job_id = v_job.id
      and a.profile_id = v_job.profile_id
      and a.lease_token = v_job.lease_token
      and a.status = 'started';

    update public.credit_reservations r
    set status = 'consumed', finalized_at = now()
    where r.job_id = v_job.id and r.status = 'reserved';

    update public.generation_jobs j
    set status = 'indeterminate',
        error_code = 'generation_lease_expired',
        error_detail = 'Worker lease expired; deterministic output recovery is required.',
        lease_expires_at = null,
        completed_at = now()
    where j.id = v_job.id;

    return query select
      v_job.active_attempt_id,
      v_job.lease_token,
      null::timestamptz,
      false,
      'indeterminate'::text;
    return;
  end if;

  if v_job.status <> 'reserved' then
    if v_job.status = 'generating' and (
      v_job.active_attempt_id is null
      or v_job.lease_token is null
      or not exists (
        select 1
        from public.generation_attempts a
        where a.id = v_job.active_attempt_id
          and a.job_id = v_job.id
          and a.profile_id = v_job.profile_id
          and a.lease_token = v_job.lease_token
          and a.status = 'started'
      )
    ) then
      raise exception using errcode = 'P0001', message = 'scene_job_state_corrupt';
    end if;

    return query select
      v_job.active_attempt_id,
      v_job.lease_token,
      v_job.lease_expires_at,
      false,
      v_job.status;
    return;
  end if;

  if v_job.reservation_expires_at < now() then
    update public.credit_reservations r
    set status = 'released', finalized_at = now()
    where r.job_id = v_job.id and r.status = 'reserved';
    update public.generation_jobs j
    set status = 'failed',
        error_code = 'generation_reservation_expired',
        error_detail = 'No worker claimed the reserved generation job.',
        completed_at = now()
    where j.id = v_job.id;
    return query select
      null::uuid, null::uuid, null::timestamptz, false, 'failed'::text;
    return;
  end if;

  select (coalesce(max(a.attempt_number), 0) + 1)::smallint
  into v_attempt_number
  from public.generation_attempts a
  where a.job_id = v_job.id;

  v_lease_token := gen_random_uuid();
  -- Covers bounded reference assembly + the 90-second provider call + durable
  -- output recording. A worker never receives a second lease/provider attempt.
  v_lease_expires_at := now() + interval '5 minutes';

  insert into public.generation_attempts (
    job_id, profile_id, attempt_number, lease_token, lease_expires_at,
    provider, model_ref, meta
  ) values (
    v_job.id, v_job.profile_id, v_attempt_number, v_lease_token,
    v_lease_expires_at, v_job.provider, v_job.model_ref, p_attempt_meta
  ) returning id into v_attempt_id;

  update public.generation_jobs j
  set status = 'generating',
      active_attempt_id = v_attempt_id,
      lease_token = v_lease_token,
      lease_expires_at = v_lease_expires_at,
      started_at = coalesce(j.started_at, now()),
      completed_at = null,
      error_code = null,
      error_detail = null
  where j.id = v_job.id and j.status = 'reserved';

  return query select
    v_attempt_id,
    v_lease_token,
    v_lease_expires_at,
    true,
    'generating'::text;
end;
$$;

-- Provider response details may be appended at any terminal boundary, but only
-- this bounded allowlist is accepted. It prevents arbitrary request/user data
-- from being smuggled into an unbounded service-owned audit column.
create or replace function public.scene_attempt_meta_patch_valid(p_patch jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select
    p_patch is not null
    and jsonb_typeof(p_patch) = 'object'
    and octet_length(p_patch::text) <= 16384
    and (p_patch - array[
      'response_id', 'model_version', 'usage',
      'provider_call_count', 'finish_reason'
    ]::text[]) = '{}'::jsonb
    and (
      not (p_patch ? 'response_id')
      or jsonb_typeof(p_patch -> 'response_id') in ('string', 'null')
    )
    and (
      not (p_patch ? 'model_version')
      or jsonb_typeof(p_patch -> 'model_version') in ('string', 'null')
    )
    and (
      not (p_patch ? 'usage')
      or jsonb_typeof(p_patch -> 'usage') in ('object', 'null')
    )
    and (
      not (p_patch ? 'provider_call_count')
      or jsonb_typeof(p_patch -> 'provider_call_count') = 'number'
    )
    and (
      not (p_patch ? 'finish_reason')
      or jsonb_typeof(p_patch -> 'finish_reason') in ('string', 'null')
    )
$$;

-- Persist the provider output only after Storage confirms the deterministic
-- object exists, and before creating the project/asset. Retrying this RPC with
-- the same lease and content hash is idempotent. An indeterminate worker may be
-- recovered with its original lease capability; no second provider call occurs.
create or replace function public.record_scene_generation_output(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_mime_type text,
  p_width integer,
  p_height integer,
  p_content_sha256 text,
  p_finalization_payload jsonb,
  p_attempt_meta_patch jsonb default '{}'::jsonb,
  p_latency_ms integer default null
)
returns table (
  job_status text,
  recorded boolean,
  cleanup_required boolean,
  cleanup_paths text[],
  cleanup_not_before timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_expected_path text;
  v_terminal_cleanup boolean;
begin
  v_expected_path := public.scene_output_storage_path(
    p_profile_id, p_job_id, p_mime_type
  );

  if p_storage_bucket is null or p_storage_bucket <> 'edits'
    or p_mime_type is null
    or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
    or p_storage_path is null
    or p_storage_path is distinct from v_expected_path
    or p_width is null or p_width <= 0
    or p_height is null or p_height <= 0
    or p_content_sha256 is null
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_finalization_payload is null
    or jsonb_typeof(p_finalization_payload) <> 'object'
    or octet_length(p_finalization_payload::text) > 65536
    or (
      p_finalization_payload ? 'project_name'
      and jsonb_typeof(p_finalization_payload -> 'project_name') <> 'string'
    )
    or (
      p_finalization_payload ? 'project_meta'
      and jsonb_typeof(p_finalization_payload -> 'project_meta') <> 'object'
    )
    or (
      p_finalization_payload ? 'provenance'
      and jsonb_typeof(p_finalization_payload -> 'provenance') <> 'object'
    )
    or not public.scene_attempt_meta_patch_valid(p_attempt_meta_patch)
    or (p_latency_ms is not null and p_latency_ms < 0) then
    raise exception using errcode = '22023', message = 'scene_output_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select j.* into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'scene_job_missing';
  end if;

  if v_job.active_attempt_id is distinct from p_attempt_id
    or v_job.lease_token is distinct from p_lease_token
    or not exists (
      select 1
      from public.generation_attempts a
      where a.id = p_attempt_id
        and a.job_id = p_job_id
        and a.profile_id = p_profile_id
        and a.lease_token = p_lease_token
        and a.status in (
          'started', 'output_recorded', 'succeeded',
          'failed', 'canceled', 'indeterminate'
        )
    ) then
    raise exception using errcode = 'P0001', message = 'scene_job_lease_lost';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = p_storage_bucket and o.name = p_storage_path
  ) then
    raise exception using errcode = 'P0001', message = 'scene_output_object_missing';
  end if;

  if v_job.pending_storage_path is not null then
    if v_job.pending_storage_bucket is distinct from p_storage_bucket
      or v_job.pending_storage_path is distinct from p_storage_path
      or v_job.pending_mime_type is distinct from p_mime_type
      or v_job.pending_width is distinct from p_width
      or v_job.pending_height is distinct from p_height
      or v_job.pending_content_sha256 is distinct from p_content_sha256
      or v_job.finalization_payload is distinct from p_finalization_payload then
      raise exception using errcode = '22023', message = 'scene_output_conflict';
    end if;

    update public.generation_attempts a
    set meta = a.meta || p_attempt_meta_patch,
        provider_request_id = coalesce(
          left(p_attempt_meta_patch ->> 'response_id', 200),
          a.provider_request_id
        ),
        latency_ms = coalesce(p_latency_ms, a.latency_ms)
    where a.id = p_attempt_id and a.lease_token = p_lease_token;

    return query select
      v_job.status,
      false,
      v_job.cleanup_required_at is not null,
      case
        when v_job.cleanup_required_at is not null
          then public.scene_output_storage_paths(v_job.profile_id, v_job.id)
        else array[]::text[]
      end,
      v_job.cleanup_not_before;
    return;
  end if;

  if v_job.status not in ('generating', 'indeterminate', 'failed', 'canceled') then
    raise exception using errcode = 'P0001', message = 'scene_job_not_recordable';
  end if;

  v_terminal_cleanup := v_job.status in ('failed', 'canceled');

  update public.generation_attempts a
  set status = case
        when v_terminal_cleanup then a.status
        else 'output_recorded'
      end,
      provider_request_id = coalesce(
        left(p_attempt_meta_patch ->> 'response_id', 200),
        a.provider_request_id
      ),
      latency_ms = coalesce(p_latency_ms, a.latency_ms),
      error_code = case when v_terminal_cleanup then a.error_code else null end,
      error_detail = case when v_terminal_cleanup then a.error_detail else null end,
      meta = a.meta || p_attempt_meta_patch,
      completed_at = case when v_terminal_cleanup then a.completed_at else null end
  where a.id = p_attempt_id
    and a.job_id = p_job_id
    and a.profile_id = p_profile_id
    and a.lease_token = p_lease_token;

  update public.generation_jobs j
  set status = case when v_terminal_cleanup then j.status else 'output_pending' end,
      pending_storage_bucket = p_storage_bucket,
      pending_storage_path = p_storage_path,
      pending_mime_type = p_mime_type,
      pending_width = p_width,
      pending_height = p_height,
      pending_content_sha256 = p_content_sha256,
      provider_response_id = coalesce(
        left(p_attempt_meta_patch ->> 'response_id', 200),
        j.provider_response_id
      ),
      provider_completed_at = now(),
      output_recorded_at = now(),
      finalization_payload = p_finalization_payload,
      cleanup_required_at = case
        when v_terminal_cleanup then coalesce(j.cleanup_required_at, now())
        else null
      end,
      cleanup_not_before = case
        when v_terminal_cleanup then coalesce(j.cleanup_not_before, now())
        else null
      end,
      cleanup_completed_at = case
        when v_terminal_cleanup then null
        else j.cleanup_completed_at
      end,
      lease_expires_at = null,
      completed_at = case when v_terminal_cleanup then j.completed_at else null end,
      error_code = case when v_terminal_cleanup then j.error_code else null end,
      error_detail = case when v_terminal_cleanup then j.error_detail else null end
  where j.id = p_job_id;

  -- A verified provider output always consumes units, even if a concurrent
  -- cancel/failure means the object now requires deletion.
  update public.credit_reservations r
  set status = 'consumed', finalized_at = now()
  where r.job_id = p_job_id and r.status in ('reserved', 'released');

  return query select
    case when v_terminal_cleanup then v_job.status else 'output_pending'::text end,
    true,
    v_terminal_cleanup,
    case
      when v_terminal_cleanup
        then public.scene_output_storage_paths(p_profile_id, p_job_id)
      else array[]::text[]
    end,
    case
      when v_terminal_cleanup then coalesce(v_job.cleanup_not_before, now())
      else null::timestamptz
    end;
end;
$$;

-- Finalization consumes only the durable pending-output record. It never trusts
-- a fresh path/MIME/project payload supplied after the provider call. The job
-- lock makes project, asset, attempt, quota, and taste-event commits atomic.
create or replace function public.finalize_scene_generation(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_attempt_meta_patch jsonb default '{}'::jsonb
)
returns table (project_id uuid, asset_id uuid, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_project_id uuid;
  v_asset_id uuid;
  v_project_name text;
  v_project_meta jsonb;
  v_provenance jsonb;
begin
  if not public.scene_attempt_meta_patch_valid(p_attempt_meta_patch) then
    raise exception using errcode = '22023', message = 'scene_attempt_meta_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select j.* into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'scene_job_missing';
  end if;

  if v_job.status = 'succeeded' then
    select a.project_id, a.id into v_project_id, v_asset_id
    from public.generated_assets a
    where a.job_id = p_job_id and a.profile_id = p_profile_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'scene_job_state_corrupt';
    end if;

    if v_job.active_attempt_id = p_attempt_id
      and v_job.lease_token = p_lease_token then
      update public.generation_attempts a
      set meta = a.meta || p_attempt_meta_patch,
          provider_request_id = coalesce(
            left(p_attempt_meta_patch ->> 'response_id', 200),
            a.provider_request_id
          )
      where a.id = p_attempt_id and a.lease_token = p_lease_token;
    end if;

    return query select v_project_id, v_asset_id, true;
    return;
  end if;

  if v_job.status = 'canceled' then
    raise exception using errcode = 'P0001', message = 'scene_job_canceled';
  end if;
  if v_job.status <> 'output_pending'
    or v_job.active_attempt_id is distinct from p_attempt_id
    or v_job.lease_token is distinct from p_lease_token
    or not exists (
      select 1
      from public.generation_attempts a
      where a.id = p_attempt_id
        and a.job_id = p_job_id
        and a.profile_id = p_profile_id
        and a.lease_token = p_lease_token
        and a.status = 'output_recorded'
    ) then
    raise exception using errcode = 'P0001', message = 'scene_job_lease_lost';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = v_job.pending_storage_bucket
      and o.name = v_job.pending_storage_path
  ) then
    raise exception using errcode = 'P0001', message = 'scene_output_object_missing';
  end if;

  v_project_name := left(
    coalesce(nullif(v_job.finalization_payload ->> 'project_name', ''), 'Generated scene'),
    80
  );
  v_project_meta := coalesce(v_job.finalization_payload -> 'project_meta', '{}'::jsonb);
  v_provenance := coalesce(v_job.finalization_payload -> 'provenance', '{}'::jsonb);

  insert into public.projects (profile_id, kind, name, status, meta)
  values (
    p_profile_id,
    'scene',
    v_project_name,
    'ready',
    v_project_meta || jsonb_build_object(
      'ai_generated', true,
      'job_id', p_job_id,
      'request_hash', v_job.request_hash,
      'model_ref', v_job.model_ref,
      'prompt_version', v_job.prompt_version,
      'storage_path', v_job.pending_storage_path,
      'content_sha256', v_job.pending_content_sha256
    )
  ) returning id into v_project_id;

  insert into public.generated_assets (
    job_id, project_id, profile_id, storage_bucket, storage_path, mime_type,
    width, height, content_sha256, provenance
  ) values (
    p_job_id,
    v_project_id,
    p_profile_id,
    v_job.pending_storage_bucket,
    v_job.pending_storage_path,
    v_job.pending_mime_type,
    v_job.pending_width,
    v_job.pending_height,
    v_job.pending_content_sha256,
    v_provenance || jsonb_build_object(
      'provider', v_job.provider,
      'model_ref', v_job.model_ref,
      'prompt_version', v_job.prompt_version,
      'request_hash', v_job.request_hash,
      'content_sha256', v_job.pending_content_sha256
    )
  ) returning id into v_asset_id;

  update public.generation_attempts a
  set status = 'succeeded',
      meta = a.meta || p_attempt_meta_patch,
      provider_request_id = coalesce(
        left(p_attempt_meta_patch ->> 'response_id', 200),
        a.provider_request_id,
        v_job.provider_response_id
      ),
      completed_at = now(),
      error_code = null,
      error_detail = null
  where a.id = p_attempt_id
    and a.job_id = p_job_id
    and a.profile_id = p_profile_id
    and a.lease_token = p_lease_token
    and a.status = 'output_recorded';

  update public.generation_jobs j
  set status = 'succeeded',
      project_id = v_project_id,
      completed_at = now(),
      cleanup_required_at = null,
      cleanup_not_before = null,
      lease_expires_at = null,
      error_code = null,
      error_detail = null
  where j.id = p_job_id and j.status = 'output_pending';

  update public.credit_reservations r
  set status = 'consumed', finalized_at = coalesce(r.finalized_at, now())
  where r.job_id = p_job_id;

  insert into public.taste_events (profile_id, event_type, subject)
  values (
    p_profile_id,
    'scene_generated',
    jsonb_build_object(
      'job_id', p_job_id,
      'project_id', v_project_id,
      'asset_id', v_asset_id,
      'units', v_job.units,
      'quality', v_job.quality,
      'model', v_job.model_ref,
      'request_id', v_job.idempotency_key,
      'batch_id', v_job.batch_id,
      'request_hash', v_job.request_hash,
      'content_sha256', v_job.pending_content_sha256
    )
  );

  return query select v_project_id, v_asset_id, false;
end;
$$;

-- A provider failure is an active-attempt compare-and-swap. The Edge function
-- explicitly chooses release only when it knows no billable provider call was
-- made; otherwise units are consumed. Durable output cannot be failed away.
create or replace function public.fail_scene_generation(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_error_detail text default null,
  p_credit_disposition text default 'consume',
  p_attempt_meta_patch jsonb default '{}'::jsonb,
  p_latency_ms integer default null
)
returns table (
  job_status text,
  applied boolean,
  cleanup_bucket text,
  cleanup_paths text[],
  cleanup_required boolean,
  cleanup_not_before timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_job public.generation_jobs%rowtype;
begin
  if coalesce(p_error_code, '') = ''
    or p_credit_disposition is null
    or p_credit_disposition not in ('consume', 'release')
    or not public.scene_attempt_meta_patch_valid(p_attempt_meta_patch)
    or (p_latency_ms is not null and p_latency_ms < 0) then
    raise exception using errcode = '22023', message = 'scene_failure_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select j.* into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'scene_job_missing';
  end if;

  if v_job.status = 'output_pending' then
    raise exception using errcode = 'P0001', message = 'scene_output_requires_finalization';
  end if;

  if v_job.status in ('succeeded', 'failed', 'canceled', 'indeterminate') then
    if v_job.active_attempt_id = p_attempt_id
      and v_job.lease_token = p_lease_token then
      update public.generation_attempts a
      set meta = a.meta || p_attempt_meta_patch,
          provider_request_id = coalesce(
            left(p_attempt_meta_patch ->> 'response_id', 200),
            a.provider_request_id
          ),
          latency_ms = coalesce(p_latency_ms, a.latency_ms)
      where a.id = p_attempt_id and a.lease_token = p_lease_token;
    end if;
    return query select
      v_job.status,
      false,
      case when v_job.cleanup_required_at is not null then 'edits'::text else null::text end,
      case
        when v_job.cleanup_required_at is not null
          then public.scene_output_storage_paths(v_job.profile_id, v_job.id)
        else array[]::text[]
      end,
      v_job.cleanup_required_at is not null,
      v_job.cleanup_not_before;
    return;
  end if;

  if v_job.status <> 'generating'
    or v_job.active_attempt_id is distinct from p_attempt_id
    or v_job.lease_token is distinct from p_lease_token
    or not exists (
      select 1
      from public.generation_attempts a
      where a.id = p_attempt_id
        and a.job_id = p_job_id
        and a.profile_id = p_profile_id
        and a.lease_token = p_lease_token
        and a.status = 'started'
    ) then
    raise exception using errcode = 'P0001', message = 'scene_job_lease_lost';
  end if;

  update public.generation_attempts a
  set status = 'failed',
      provider_request_id = coalesce(
        left(p_attempt_meta_patch ->> 'response_id', 200),
        a.provider_request_id
      ),
      latency_ms = coalesce(p_latency_ms, a.latency_ms),
      error_code = left(p_error_code, 120),
      error_detail = left(p_error_detail, 500),
      meta = a.meta || p_attempt_meta_patch,
      completed_at = now()
  where a.id = p_attempt_id
    and a.job_id = p_job_id
    and a.profile_id = p_profile_id
    and a.lease_token = p_lease_token
    and a.status = 'started';

  update public.generation_jobs j
  set status = 'failed',
      error_code = left(p_error_code, 120),
      error_detail = left(p_error_detail, 500),
      provider_response_id = coalesce(
        left(p_attempt_meta_patch ->> 'response_id', 200),
        j.provider_response_id
      ),
      completed_at = now(),
      lease_expires_at = null,
      cleanup_required_at = coalesce(j.cleanup_required_at, now()),
      cleanup_not_before = coalesce(j.cleanup_not_before, now()),
      cleanup_completed_at = null
  where j.id = p_job_id
    and j.status = 'generating'
    and j.active_attempt_id = p_attempt_id
    and j.lease_token = p_lease_token;

  update public.credit_reservations r
  set status = case
        when p_credit_disposition = 'consume' then 'consumed'
        else 'released'
      end,
      finalized_at = now()
  where r.job_id = p_job_id and r.status = 'reserved';

  return query select
    'failed'::text,
    true,
    'edits'::text,
    public.scene_output_storage_paths(p_profile_id, p_job_id),
    true,
    now();
end;
$$;

-- Cancellation serializes with claim/record/finalize. Pending output remains a
-- cleanup obligation and its deterministic path is returned to the Edge
-- function. Generating/indeterminate work is conservatively quota-consumed.
create or replace function public.cancel_scene_generation(
  p_profile_id uuid,
  p_idempotency_key text
)
returns table (
  job_id uuid,
  job_status text,
  attempt_id uuid,
  cleanup_bucket text,
  cleanup_paths text[],
  cleanup_required boolean,
  cleanup_not_before timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_cleanup_required boolean;
  v_cleanup_not_before timestamptz;
  v_attempt_lease_expires_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select j.* into v_job
  from public.generation_jobs j
  where j.profile_id = p_profile_id
    and j.idempotency_key = p_idempotency_key
  for update;
  if not found then
    return;
  end if;

  if v_job.status in ('succeeded', 'failed', 'canceled') then
    return query select
      v_job.id,
      v_job.status,
      v_job.active_attempt_id,
      case when v_job.cleanup_required_at is not null then 'edits'::text else null::text end,
      case
        when v_job.cleanup_required_at is not null
          then public.scene_output_storage_paths(v_job.profile_id, v_job.id)
        else array[]::text[]
      end,
      v_job.cleanup_required_at is not null,
      v_job.cleanup_not_before;
    return;
  end if;

  if v_job.active_attempt_id is not null then
    select a.lease_expires_at into v_attempt_lease_expires_at
    from public.generation_attempts a
    where a.id = v_job.active_attempt_id
      and a.job_id = v_job.id
      and a.profile_id = v_job.profile_id;
  end if;

  v_cleanup_required := v_job.status <> 'reserved'
    and (v_job.active_attempt_id is not null or v_job.pending_storage_path is not null);
  v_cleanup_not_before := case
    when not v_cleanup_required then null
    when v_job.status = 'output_pending' then now()
    else greatest(
      now(),
      coalesce(v_job.lease_expires_at, v_attempt_lease_expires_at, now())
    ) + interval '30 seconds'
  end;

  update public.generation_attempts a
  set status = 'canceled',
      error_code = 'user_canceled',
      error_detail = 'Generation was canceled by the user.',
      completed_at = coalesce(a.completed_at, now())
  where a.id = v_job.active_attempt_id
    and a.job_id = v_job.id
    and a.profile_id = v_job.profile_id
    and a.status in ('started', 'output_recorded', 'indeterminate');

  update public.generation_jobs j
  set status = 'canceled',
      cancel_requested_at = coalesce(j.cancel_requested_at, now()),
      error_code = 'user_canceled',
      error_detail = 'Generation was canceled by the user.',
      completed_at = now(),
      lease_expires_at = null,
      cleanup_required_at = case
        when v_cleanup_required then coalesce(j.cleanup_required_at, now())
        else null
      end,
      cleanup_not_before = case
        when v_cleanup_required then coalesce(j.cleanup_not_before, v_cleanup_not_before)
        else null
      end,
      cleanup_completed_at = case
        when v_cleanup_required then null
        else j.cleanup_completed_at
      end
  where j.id = v_job.id;

  update public.credit_reservations r
  set status = case when v_job.status = 'reserved' then 'released' else 'consumed' end,
      finalized_at = now()
  where r.job_id = v_job.id and r.status = 'reserved';

  return query select
    v_job.id,
    'canceled'::text,
    v_job.active_attempt_id,
    case when v_cleanup_required then 'edits'::text else null::text end,
    case
      when v_cleanup_required
        then public.scene_output_storage_paths(v_job.profile_id, v_job.id)
      else array[]::text[]
    end,
    v_cleanup_required,
    v_cleanup_not_before;
end;
$$;

-- Store one immutable identity-distance label per evaluator version. The job
-- lock makes concurrent replays deterministic; a changed input under the same
-- evaluator version is an idempotency conflict rather than an update.
create or replace function public.record_scene_identity_evaluation(
  p_job_id uuid,
  p_profile_id uuid,
  p_asset_id uuid,
  p_evaluator_version text,
  p_distance numeric,
  p_threshold numeric
)
returns table (
  evaluation_id uuid,
  passed boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_existing public.generation_identity_evaluations%rowtype;
  v_evaluation_id uuid;
  v_passed boolean;
begin
  if p_evaluator_version is null
    or char_length(p_evaluator_version) not between 1 and 120
    or p_distance is null or p_distance < 0 or p_distance > 1000000
    or p_threshold is null or p_threshold <= 0 or p_threshold > 1000000 then
    raise exception using errcode = '22023', message = 'scene_identity_evaluation_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select j.* into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'scene_job_missing';
  end if;
  if v_job.status <> 'succeeded' then
    raise exception using errcode = 'P0001', message = 'scene_identity_job_not_succeeded';
  end if;
  if not exists (
    select 1
    from public.generated_assets a
    where a.id = p_asset_id
      and a.job_id = p_job_id
      and a.profile_id = p_profile_id
  ) then
    raise exception using errcode = 'P0001', message = 'scene_identity_asset_mismatch';
  end if;

  select e.* into v_existing
  from public.generation_identity_evaluations e
  where e.job_id = p_job_id
    and e.evaluator_version = p_evaluator_version;

  if found then
    if v_existing.profile_id <> p_profile_id
      or v_existing.asset_id <> p_asset_id
      or v_existing.distance <> p_distance
      or v_existing.threshold <> p_threshold then
      raise exception using errcode = '22023', message = 'scene_identity_evaluation_conflict';
    end if;
    return query select v_existing.id, v_existing.passed, true;
    return;
  end if;

  v_passed := p_distance <= p_threshold;
  insert into public.generation_identity_evaluations (
    job_id, profile_id, asset_id, evaluator_version,
    distance, threshold, passed
  ) values (
    p_job_id, p_profile_id, p_asset_id, p_evaluator_version,
    p_distance, p_threshold, v_passed
  ) returning id into v_evaluation_id;

  return query select v_evaluation_id, v_passed, false;
end;
$$;

-- Storage deletion is intentionally performed through the Storage API. This
-- acknowledgement clears the durable cleanup marker only after the worker
-- lease/grace window closes and storage.objects proves all three exact MIME
-- candidates are gone. No prefix scan is needed.
create or replace function public.acknowledge_scene_output_cleanup(
  p_job_id uuid,
  p_profile_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_job public.generation_jobs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select j.* into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'scene_job_missing';
  end if;

  if v_job.status not in ('failed', 'canceled') then
    raise exception using errcode = 'P0001', message = 'scene_cleanup_not_allowed';
  end if;
  if v_job.cleanup_required_at is null then
    return false;
  end if;
  if v_job.cleanup_not_before is null then
    raise exception using errcode = 'P0001', message = 'scene_job_state_corrupt';
  end if;
  if now() < v_job.cleanup_not_before then
    raise exception using errcode = 'P0001', message = 'scene_cleanup_lease_active';
  end if;
  if exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'edits'
      and o.name = any(public.scene_output_storage_paths(v_job.profile_id, v_job.id))
  ) then
    raise exception using errcode = 'P0001', message = 'scene_cleanup_object_still_exists';
  end if;

  update public.generation_jobs j
  set pending_storage_bucket = null,
      pending_storage_path = null,
      pending_mime_type = null,
      pending_width = null,
      pending_height = null,
      pending_content_sha256 = null,
      provider_completed_at = null,
      output_recorded_at = null,
      finalization_payload = null,
      cleanup_required_at = null,
      cleanup_not_before = null,
      cleanup_completed_at = now()
  where j.id = p_job_id;

  return true;
end;
$$;

-- Remove pre-integrity overloads that could otherwise remain executable in a
-- drifted environment after CREATE OR REPLACE introduces the new signatures.
drop function if exists public.finalize_scene_generation(
  uuid, uuid, uuid, uuid, text, text, text, integer, integer,
  text, jsonb, jsonb, text, integer
);
drop function if exists public.fail_scene_generation(
  uuid, uuid, uuid, uuid, text, text, boolean, boolean, text, integer
);
drop function if exists public.acknowledge_scene_output_cleanup(uuid, uuid, text);

revoke execute on function public.scene_manifest_sha256(jsonb)
  from public, anon, authenticated;
revoke execute on function public.scene_output_storage_path(uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.scene_output_storage_paths(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.scene_attempt_meta_patch_valid(jsonb)
  from public, anon, authenticated;
revoke execute on function public.reserve_scene_generation(
  uuid, text, text, jsonb, integer, text, text, text, text, text
) from public, anon, authenticated;
revoke execute on function public.start_scene_generation(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.record_scene_generation_output(
  uuid, uuid, uuid, uuid, text, text, text, integer, integer,
  text, jsonb, jsonb, integer
) from public, anon, authenticated;
revoke execute on function public.finalize_scene_generation(
  uuid, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
revoke execute on function public.fail_scene_generation(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, integer
) from public, anon, authenticated;
revoke execute on function public.cancel_scene_generation(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.record_scene_identity_evaluation(
  uuid, uuid, uuid, text, numeric, numeric
) from public, anon, authenticated;
revoke execute on function public.acknowledge_scene_output_cleanup(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.guard_server_owned_profile_fields()
  from public, anon, authenticated;
revoke execute on function public.guard_generated_scene_projects()
  from public, anon, authenticated;

grant execute on function public.reserve_scene_generation(
  uuid, text, text, jsonb, integer, text, text, text, text, text
) to service_role;
grant execute on function public.start_scene_generation(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.record_scene_generation_output(
  uuid, uuid, uuid, uuid, text, text, text, integer, integer,
  text, jsonb, jsonb, integer
) to service_role;
grant execute on function public.finalize_scene_generation(
  uuid, uuid, uuid, uuid, jsonb
) to service_role;
grant execute on function public.fail_scene_generation(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, integer
) to service_role;
grant execute on function public.cancel_scene_generation(uuid, text)
  to service_role;
grant execute on function public.record_scene_identity_evaluation(
  uuid, uuid, uuid, text, numeric, numeric
) to service_role;
grant execute on function public.acknowledge_scene_output_cleanup(uuid, uuid)
  to service_role;

commit;
