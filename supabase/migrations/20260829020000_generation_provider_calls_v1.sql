-- Per-HTTP-call scene generation ledger and anti-copy decision gate.
-- Rejected candidates have no Storage columns by construction. A generation
-- job has at most two calls: the user-reserved initial call and one
-- system-funded anti-copy reroll.

create table if not exists public.generation_provider_calls (
  id uuid primary key,
  job_id uuid not null,
  attempt_id uuid not null,
  profile_id uuid not null,
  call_index smallint not null check (call_index in (0, 1)),
  purpose text not null check (
    purpose in ('initial', 'anti_copy_reroll')
  ),
  funding_source text not null check (
    funding_source in ('user_reserved', 'system_anti_copy')
  ),
  provider text not null,
  model_ref text not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  reference_manifest_hash text not null
    check (reference_manifest_hash ~ '^[a-f0-9]{64}$'),
  reference_content_hashes text[] not null,
  aesthetic_reference_hashes text[] not null,
  identity_reference_hashes text[] not null default '{}'::text[],
  status text not null default 'prepared' check (
    status in (
      'prepared',
      'provider_rejected',
      'provider_failed',
      'indeterminate',
      'copy_rejected',
      'accepted'
    )
  ),
  provider_request_id text,
  provider_response_id text,
  input_units bigint check (input_units is null or input_units >= 0),
  output_units bigint check (output_units is null or output_units >= 0),
  cost_micros bigint check (cost_micros is null or cost_micros >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  billing_state text not null default 'pending' check (
    billing_state in ('pending', 'reported', 'not_billable', 'unknown')
  ),
  output_mime text check (
    output_mime is null or output_mime in ('image/jpeg', 'image/png', 'image/webp')
  ),
  output_width integer check (output_width is null or output_width > 0),
  output_height integer check (output_height is null or output_height > 0),
  output_content_sha256 text check (
    output_content_sha256 is null
    or output_content_sha256 ~ '^[a-f0-9]{64}$'
  ),
  embedding_model text,
  anti_copy_policy_version text,
  anti_copy_threshold double precision,
  output_embedding_digest text check (
    output_embedding_digest is null
    or output_embedding_digest ~ '^[a-f0-9]{64}$'
  ),
  maximum_similarity double precision check (
    maximum_similarity is null
    or maximum_similarity between -1 and 1
  ),
  matched_reference_kind text check (
    matched_reference_kind is null
    or matched_reference_kind in (
      'retrieved_style',
      'user_inspiration',
      'realism',
      'environment',
      'identity'
    )
  ),
  matched_reference_sha256 text check (
    matched_reference_sha256 is null
    or matched_reference_sha256 ~ '^[a-f0-9]{64}$'
  ),
  provider_meta jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  started_at timestamptz not null default now(),
  provider_completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (job_id, call_index),
  unique (id, job_id, profile_id),
  foreign key (job_id, profile_id)
    references public.generation_jobs(id, profile_id)
    on delete cascade,
  foreign key (attempt_id, profile_id)
    references public.generation_attempts(id, profile_id)
    on delete cascade,
  foreign key (job_id, profile_id, reference_manifest_hash)
    references public.generation_reference_snapshots(
      job_id,
      profile_id,
      manifest_hash
    )
    on delete cascade,
  check (
    cardinality(reference_content_hashes) >= 1
    and cardinality(reference_content_hashes) <= 12
    and cardinality(aesthetic_reference_hashes) <= 12
    and cardinality(identity_reference_hashes) <= 6
    and reference_content_hashes =
      aesthetic_reference_hashes || identity_reference_hashes
  ),
  check (
    call_index = 0
      and purpose = 'initial'
      and funding_source = 'user_reserved'
    or
    call_index = 1
      and purpose = 'anti_copy_reroll'
      and funding_source = 'system_anti_copy'
  ),
  check (
    (status = 'prepared' and provider_completed_at is null)
    or
    (status <> 'prepared' and provider_completed_at is not null)
  ),
  check (
    status not in ('copy_rejected', 'accepted')
    or (
      output_mime is not null
      and output_width is not null
      and output_height is not null
      and output_content_sha256 is not null
      and embedding_model = 'gemini-embedding-2'
      and anti_copy_policy_version = 'scene-anti-copy-v1'
      and anti_copy_threshold = 0.95
      and output_embedding_digest is not null
      and maximum_similarity is not null
      and matched_reference_kind is not null
      and matched_reference_sha256 is not null
      and matched_reference_sha256 = any(reference_content_hashes)
    )
  ),
  check (
    status <> 'copy_rejected' or maximum_similarity > 0.95
  ),
  check (
    status <> 'accepted' or maximum_similarity <= 0.95
  )
);

create index if not exists generation_provider_calls_profile_idx
  on public.generation_provider_calls (profile_id, started_at desc);

alter table public.generation_provider_calls enable row level security;
revoke all on public.generation_provider_calls from public, anon, authenticated;

create or replace function public.prevent_terminal_generation_call_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'prepared' and new is distinct from old then
    raise exception 'terminal_generation_provider_call_is_immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists generation_provider_call_terminal_immutable
  on public.generation_provider_calls;
create trigger generation_provider_call_terminal_immutable
before update on public.generation_provider_calls
for each row execute function public.prevent_terminal_generation_call_mutation();

create or replace function public.reserve_scene_provider_call(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_call_id uuid,
  p_call_index integer,
  p_provider text,
  p_model_ref text,
  p_request_hash text,
  p_reference_manifest_hash text,
  p_aesthetic_reference_hashes text[],
  p_identity_reference_hashes text[]
)
returns table (
  invoke_allowed boolean,
  provider_call_id uuid,
  call_status text,
  funding_source text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_attempt public.generation_attempts%rowtype;
  v_existing public.generation_provider_calls%rowtype;
  v_snapshot public.generation_reference_snapshots%rowtype;
  v_purpose text;
  v_funding text;
  v_reference_content_hashes text[];
begin
  v_reference_content_hashes :=
    coalesce(p_aesthetic_reference_hashes, '{}'::text[])
    || coalesce(p_identity_reference_hashes, '{}'::text[]);

  if p_call_index not in (0, 1)
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_reference_manifest_hash !~ '^[a-f0-9]{64}$'
    or cardinality(v_reference_content_hashes) not between 1 and 12
    or cardinality(coalesce(p_aesthetic_reference_hashes, '{}'::text[])) > 12
    or cardinality(coalesce(p_identity_reference_hashes, '{}'::text[])) > 6
    or exists (
      select 1
      from unnest(v_reference_content_hashes) as hashes(value)
      where hashes.value !~ '^[a-f0-9]{64}$'
    )
    or cardinality(v_reference_content_hashes) <>
      cardinality(array(
        select distinct hashes.value
        from unnest(v_reference_content_hashes) as hashes(value)
      ))
    or p_provider is null
    or length(p_provider) > 100
    or p_model_ref is null
    or length(p_model_ref) > 200 then
    raise exception 'invalid_scene_provider_call' using errcode = '22023';
  end if;

  select * into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'generation_job_not_found' using errcode = 'P0002';
  end if;

  select * into v_attempt
  from public.generation_attempts a
  where a.id = p_attempt_id
    and a.job_id = p_job_id
    and a.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'generation_attempt_not_found' using errcode = 'P0002';
  end if;

  if v_job.status <> 'generating'
    or v_job.active_attempt_id <> p_attempt_id
    or v_attempt.lease_token <> p_lease_token
    or v_attempt.lease_expires_at <= now() then
    raise exception 'generation_lease_lost' using errcode = '40001';
  end if;

  select * into v_snapshot
  from public.generation_reference_snapshots s
  where s.job_id = p_job_id
    and s.profile_id = p_profile_id
    and s.candidate_index = p_call_index
    and s.manifest_hash = p_reference_manifest_hash
  for update;
  if not found
    or v_snapshot.aesthetic_reference_hashes <>
      coalesce(p_aesthetic_reference_hashes, '{}'::text[])
    or v_snapshot.identity_reference_hashes <>
      coalesce(p_identity_reference_hashes, '{}'::text[]) then
    raise exception 'generation_reference_snapshot_mismatch'
      using errcode = '23514';
  end if;

  select * into v_existing
  from public.generation_provider_calls c
  where c.job_id = p_job_id and c.call_index = p_call_index
  for update;
  if found then
    return query select false, v_existing.id, v_existing.status,
      v_existing.funding_source;
    return;
  end if;

  if p_call_index = 1 then
    select * into v_existing
    from public.generation_provider_calls c
    where c.job_id = p_job_id
      and c.call_index = 0
      and c.status = 'copy_rejected'
    for update;
    if not found then
      raise exception 'anti_copy_reroll_not_authorized' using errcode = '23514';
    end if;
    if v_existing.reference_manifest_hash = p_reference_manifest_hash
      or v_existing.aesthetic_reference_hashes &&
        coalesce(p_aesthetic_reference_hashes, '{}'::text[]) then
      raise exception 'anti_copy_reroll_reused_references' using errcode = '23514';
    end if;
  end if;

  v_purpose := case when p_call_index = 0
    then 'initial' else 'anti_copy_reroll' end;
  v_funding := case when p_call_index = 0
    then 'user_reserved' else 'system_anti_copy' end;

  insert into public.generation_provider_calls (
    id,
    job_id,
    attempt_id,
    profile_id,
    call_index,
    purpose,
    funding_source,
    provider,
    model_ref,
    request_hash,
    reference_manifest_hash,
    reference_content_hashes,
    aesthetic_reference_hashes,
    identity_reference_hashes
  ) values (
    p_call_id,
    p_job_id,
    p_attempt_id,
    p_profile_id,
    p_call_index,
    v_purpose,
    v_funding,
    p_provider,
    p_model_ref,
    p_request_hash,
    p_reference_manifest_hash,
    v_reference_content_hashes,
    coalesce(p_aesthetic_reference_hashes, '{}'::text[]),
    coalesce(p_identity_reference_hashes, '{}'::text[])
  )
  returning * into v_existing;

  update public.generation_attempts
  set lease_expires_at = now() + interval '5 minutes'
  where id = p_attempt_id and profile_id = p_profile_id;

  return query select true, v_existing.id, v_existing.status,
    v_existing.funding_source;
end;
$$;

create or replace function public.record_scene_provider_candidate(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_provider_call_id uuid,
  p_provider_request_id text,
  p_provider_response_id text,
  p_output_mime text,
  p_output_width integer,
  p_output_height integer,
  p_output_content_sha256 text,
  p_output_embedding_digest text,
  p_maximum_similarity double precision,
  p_matched_reference_kind text,
  p_matched_reference_sha256 text,
  p_input_units bigint default 0,
  p_output_units bigint default 0,
  p_cost_micros bigint default 0,
  p_provider_meta jsonb default '{}'::jsonb
)
returns table (
  provider_call_id uuid,
  decision text,
  reroll_allowed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_attempt public.generation_attempts%rowtype;
  v_call public.generation_provider_calls%rowtype;
  v_decision text;
begin
  if p_output_mime not in ('image/jpeg', 'image/png', 'image/webp')
    or p_output_width not between 64 and 8192
    or p_output_height not between 64 and 8192
    or p_output_width::bigint * p_output_height::bigint > 50000000
    or p_output_content_sha256 !~ '^[a-f0-9]{64}$'
    or p_output_embedding_digest !~ '^[a-f0-9]{64}$'
    or p_maximum_similarity not between -1 and 1
    or p_matched_reference_kind not in (
      'retrieved_style', 'user_inspiration', 'realism', 'environment', 'identity'
    )
    or p_matched_reference_sha256 !~ '^[a-f0-9]{64}$'
    or coalesce(p_input_units, 0) < 0
    or coalesce(p_output_units, 0) < 0
    or coalesce(p_cost_micros, 0) < 0 then
    raise exception 'invalid_scene_provider_candidate' using errcode = '22023';
  end if;

  select * into v_job
  from public.generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  select * into v_attempt
  from public.generation_attempts a
  where a.id = p_attempt_id
    and a.job_id = p_job_id
    and a.profile_id = p_profile_id
  for update;
  select * into v_call
  from public.generation_provider_calls c
  where c.id = p_provider_call_id
    and c.job_id = p_job_id
    and c.attempt_id = p_attempt_id
    and c.profile_id = p_profile_id
  for update;

  if v_job.id is null or v_attempt.id is null or v_call.id is null then
    raise exception 'scene_provider_call_not_found' using errcode = 'P0002';
  end if;
  if v_call.status in ('copy_rejected', 'accepted') then
    if v_call.output_content_sha256 <> p_output_content_sha256
      or v_call.maximum_similarity <> p_maximum_similarity then
      raise exception 'scene_provider_candidate_conflict' using errcode = '23505';
    end if;
    return query select v_call.id, v_call.status,
      v_call.status = 'copy_rejected' and v_call.call_index = 0;
    return;
  end if;
  if v_call.status <> 'prepared'
    or v_job.status <> 'generating'
    or v_job.active_attempt_id <> p_attempt_id
    or v_attempt.lease_token <> p_lease_token
    or v_attempt.lease_expires_at <= now() then
    raise exception 'generation_lease_lost' using errcode = '40001';
  end if;

  v_decision := case when p_maximum_similarity > 0.95
    then 'copy_rejected' else 'accepted' end;

  update public.generation_provider_calls
  set status = v_decision,
      provider_request_id = nullif(p_provider_request_id, ''),
      provider_response_id = nullif(p_provider_response_id, ''),
      input_units = coalesce(p_input_units, 0),
      output_units = coalesce(p_output_units, 0),
      cost_micros = coalesce(p_cost_micros, 0),
      billing_state = 'reported',
      output_mime = p_output_mime,
      output_width = p_output_width,
      output_height = p_output_height,
      output_content_sha256 = p_output_content_sha256,
      embedding_model = 'gemini-embedding-2',
      anti_copy_policy_version = 'scene-anti-copy-v1',
      anti_copy_threshold = 0.95,
      output_embedding_digest = p_output_embedding_digest,
      maximum_similarity = p_maximum_similarity,
      matched_reference_kind = p_matched_reference_kind,
      matched_reference_sha256 = p_matched_reference_sha256,
      provider_meta = coalesce(p_provider_meta, '{}'::jsonb),
      provider_completed_at = now(),
      updated_at = now()
  where id = p_provider_call_id;

  return query select p_provider_call_id, v_decision,
    v_decision = 'copy_rejected' and v_call.call_index = 0;
end;
$$;

create or replace function public.record_scene_provider_failure(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_provider_call_id uuid,
  p_outcome text,
  p_error_code text,
  p_error_detail text,
  p_provider_request_id text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call public.generation_provider_calls%rowtype;
begin
  if p_outcome not in ('provider_rejected', 'provider_failed', 'indeterminate') then
    raise exception 'invalid_scene_provider_failure' using errcode = '22023';
  end if;

  perform 1
  from public.generation_jobs j
  join public.generation_attempts a
    on a.id = p_attempt_id
    and a.job_id = j.id
    and a.profile_id = j.profile_id
  where j.id = p_job_id
    and j.profile_id = p_profile_id
    and j.active_attempt_id = p_attempt_id
    and j.status = 'generating'
    and a.lease_token = p_lease_token
  for update of j, a;
  if not found then
    raise exception 'generation_lease_lost' using errcode = '40001';
  end if;

  select * into v_call
  from public.generation_provider_calls c
  where c.id = p_provider_call_id
    and c.job_id = p_job_id
    and c.attempt_id = p_attempt_id
    and c.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'scene_provider_call_not_found' using errcode = 'P0002';
  end if;
  if v_call.status <> 'prepared' then
    return v_call.status;
  end if;

  update public.generation_provider_calls
  set status = p_outcome,
      provider_request_id = nullif(p_provider_request_id, ''),
      billing_state = case when p_outcome = 'provider_rejected'
        then 'not_billable' else 'unknown' end,
      error_code = left(coalesce(p_error_code, p_outcome), 100),
      error_detail = left(coalesce(p_error_detail, ''), 1000),
      provider_completed_at = now(),
      updated_at = now()
  where id = p_provider_call_id;

  return p_outcome;
end;
$$;

create or replace function public.authorize_scene_output_upload(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_provider_call_id uuid,
  p_content_sha256 text
)
returns table (
  authorized boolean,
  candidate_index integer,
  reroll_used boolean,
  maximum_similarity double precision,
  matched_reference_kind text,
  matched_reference_sha256 text
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    true,
    c.call_index::integer,
    c.call_index = 1,
    c.maximum_similarity,
    c.matched_reference_kind,
    c.matched_reference_sha256
  from public.generation_provider_calls c
  join public.generation_jobs j
    on j.id = c.job_id and j.profile_id = c.profile_id
  where c.id = p_provider_call_id
    and c.job_id = p_job_id
    and c.attempt_id = p_attempt_id
    and c.profile_id = p_profile_id
    and c.status = 'accepted'
    and c.output_content_sha256 = p_content_sha256
    and j.status = 'generating'
    and j.active_attempt_id = p_attempt_id;
$$;

revoke all on function public.reserve_scene_provider_call(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text, text, text[], text[]
) from public, anon, authenticated;
revoke all on function public.record_scene_provider_candidate(
  uuid, uuid, uuid, uuid, uuid, text, text, text, integer, integer, text,
  text, double precision, text, text, bigint, bigint, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.record_scene_provider_failure(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.authorize_scene_output_upload(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;

grant execute on function public.reserve_scene_provider_call(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text, text, text[], text[]
) to service_role;
grant execute on function public.record_scene_provider_candidate(
  uuid, uuid, uuid, uuid, uuid, text, text, text, integer, integer, text,
  text, double precision, text, text, bigint, bigint, bigint, jsonb
) to service_role;
grant execute on function public.record_scene_provider_failure(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.authorize_scene_output_upload(
  uuid, uuid, uuid, uuid, text
) to service_role;

comment on table public.generation_provider_calls is
  'Server-only, one row per actual or possibly initiated image-provider HTTP call. Rejected candidate bytes are never stored.';
