-- Bind each deliverable scene output to the exact accepted provider call before
-- Storage upload. The existing output-recording transaction remains the
-- durable boundary that consumes the user's reservation.

alter table public.generation_jobs
  add column if not exists accepted_provider_call_id uuid;

alter table public.generation_jobs
  drop constraint if exists generation_jobs_accepted_provider_call_fk;
alter table public.generation_jobs
  add constraint generation_jobs_accepted_provider_call_fk
  foreign key (accepted_provider_call_id)
  references public.generation_provider_calls(id)
  deferrable initially deferred;
create unique index if not exists generation_jobs_accepted_provider_call_uidx
  on public.generation_jobs (accepted_provider_call_id)
  where accepted_provider_call_id is not null;

-- Fixed non-identity references are attached to both candidates. Unlike the
-- exact-three retrieved aesthetic set, they do not rotate on the one allowed
-- anti-copy reroll. Identity images are intentionally excluded from this
-- snapshot because similarity to the authenticated subject is desired.
create or replace function public.scene_sha256_array_is_valid(
  p_values text[],
  p_maximum integer
)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_values is not null
    and p_maximum >= 0
    and cardinality(p_values) between 0 and p_maximum
    and array_position(p_values, null) is null
    and cardinality(p_values) = cardinality(array(
      select distinct value from unnest(p_values) as items(value)
    ))
    and not exists (
      select 1 from unnest(p_values) as items(value)
      where value !~ '^[a-f0-9]{64}$'
    )
$$;

create table if not exists public.generation_fixed_reference_snapshots (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  attempt_id uuid not null,
  profile_id uuid not null,
  manifest jsonb not null,
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  reference_hashes text[] not null default '{}'::text[],
  reference_kinds text[] not null default '{}'::text[],
  embedding_digests text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  unique (job_id),
  unique (id, job_id, profile_id),
  foreign key (job_id, profile_id)
    references public.generation_jobs(id, profile_id)
    on delete cascade,
  foreign key (attempt_id, profile_id)
    references public.generation_attempts(id, profile_id)
    on delete cascade,
  check (
    jsonb_typeof(manifest) = 'object'
    and octet_length(manifest::text) <= 65536
    and cardinality(reference_hashes) between 0 and 6
    and cardinality(reference_kinds) = cardinality(reference_hashes)
    and cardinality(embedding_digests) = cardinality(reference_hashes)
    and array_position(reference_hashes, null) is null
    and array_position(reference_kinds, null) is null
    and array_position(embedding_digests, null) is null
    and public.scene_sha256_array_is_valid(reference_hashes, 6)
    and public.scene_sha256_array_is_valid(embedding_digests, 6)
    and reference_kinds <@ array[
      'user_inspiration', 'realism', 'environment'
    ]::text[]
  )
);

alter table public.generation_fixed_reference_snapshots enable row level security;
revoke all on public.generation_fixed_reference_snapshots
  from public, anon, authenticated;

create or replace function public.record_scene_fixed_reference_snapshot(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_manifest jsonb,
  p_reference_hashes text[],
  p_reference_kinds text[],
  p_embedding_digests text[]
)
returns table (
  snapshot_id uuid,
  manifest_hash text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_attempt public.generation_attempts%rowtype;
  v_existing public.generation_fixed_reference_snapshots%rowtype;
  v_asset public.inspiration_assets%rowtype;
  v_item jsonb;
  v_ordinality bigint;
  v_count integer;
  v_manifest_hash text;
begin
  v_count := cardinality(coalesce(p_reference_hashes, '{}'::text[]));
  if p_manifest is null
    or jsonb_typeof(p_manifest) is distinct from 'object'
    or p_manifest ->> 'schema' is distinct from 'scene-fixed-reference-v1'
    or jsonb_typeof(p_manifest -> 'references') is distinct from 'array'
    or octet_length(p_manifest::text) > 65536
    or jsonb_array_length(p_manifest -> 'references') <> v_count
    or v_count not between 0 and 6
    or cardinality(coalesce(p_reference_kinds, '{}'::text[])) <> v_count
    or cardinality(coalesce(p_embedding_digests, '{}'::text[])) <> v_count
    or array_position(coalesce(p_reference_hashes, '{}'::text[]), null)
      is not null
    or array_position(coalesce(p_reference_kinds, '{}'::text[]), null)
      is not null
    or array_position(coalesce(p_embedding_digests, '{}'::text[]), null)
      is not null
    or v_count <> cardinality(array(
      select distinct hashes.value
      from unnest(coalesce(p_reference_hashes, '{}'::text[])) as hashes(value)
    ))
    or exists (
      select 1
      from unnest(coalesce(p_reference_hashes, '{}'::text[])) as hashes(value)
      where hashes.value !~ '^[a-f0-9]{64}$'
    )
    or exists (
      select 1
      from unnest(coalesce(p_reference_kinds, '{}'::text[])) as kinds(value)
      where kinds.value not in ('user_inspiration', 'realism', 'environment')
    )
    or exists (
      select 1
      from unnest(coalesce(p_embedding_digests, '{}'::text[])) as digests(value)
      where digests.value !~ '^[a-f0-9]{64}$'
    ) then
    raise exception 'invalid_scene_fixed_reference_snapshot'
      using errcode = '22023';
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
  if v_job.id is null or v_attempt.id is null then
    raise exception 'generation_job_not_found' using errcode = 'P0002';
  end if;
  if v_job.status <> 'generating'
    or v_job.active_attempt_id is distinct from p_attempt_id
    or v_job.lease_token is distinct from p_lease_token
    or v_attempt.lease_token is distinct from p_lease_token
    or v_attempt.lease_expires_at <= now() then
    raise exception 'generation_lease_lost' using errcode = '40001';
  end if;

  for v_item, v_ordinality in
    select reference.value, reference.ordinality
    from jsonb_array_elements(p_manifest -> 'references')
      with ordinality as reference(value, ordinality)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or coalesce(v_item ->> 'attachmentIndex', '') !~ '^[0-9]+$'
      or (v_item ->> 'attachmentIndex')::integer <> v_ordinality - 1
      or coalesce(v_item ->> 'attachmentPlacement', '')
        not in ('before_retrieval', 'after_retrieval')
      or (v_item ->> 'kind') is distinct from
        p_reference_kinds[v_ordinality::integer]
      or (v_item ->> 'sha256') is distinct from
        p_reference_hashes[v_ordinality::integer]
      or (v_item ->> 'embeddingModel') is distinct from
        'gemini-embedding-2'
      or (v_item ->> 'embeddingDigest') is distinct from
        p_embedding_digests[v_ordinality::integer]
      or (v_item ->> 'storageBucket') is distinct from
        'inspiration-conditioning'
      or coalesce(v_item ->> 'storagePath', '') = ''
      or length(v_item ->> 'storagePath') > 1024
      or coalesce(v_item ->> 'assetId', '') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'invalid_scene_fixed_reference_evidence'
        using errcode = '22023';
    end if;

    select * into v_asset
    from public.inspiration_assets a
    where a.id = (v_item ->> 'assetId')::uuid;
    if not found
      or v_asset.usable_for_conditioning is not true
      or v_asset.index_status <> 'ready'
      or v_asset.embedding_model <> 'gemini-embedding-2'
      or v_asset.visual_embedding is null
      or encode(
        extensions.digest(
          convert_to(v_asset.visual_embedding::text, 'UTF8'),
          'sha256'
        ),
        'hex'
      ) <> v_item ->> 'embeddingDigest'
      or v_asset.conditioning_sha256 <> v_item ->> 'sha256'
      or v_asset.conditioning_storage_bucket <>
        v_item ->> 'storageBucket'
      or v_asset.conditioning_storage_path <>
        v_item ->> 'storagePath'
      or (
        v_item ->> 'kind' = 'user_inspiration'
        and not (
          v_asset.profile_id = p_profile_id
          and v_asset.source = 'user_upload'
          and v_asset.rights = 'owned'
        )
      )
      or (
        v_item ->> 'kind' in ('realism', 'environment')
        and not (
          v_asset.profile_id is null
          and v_asset.source = 'style_pack'
          and v_asset.rights = 'licensed'
        )
      ) then
      raise exception 'scene_fixed_reference_index_evidence_mismatch'
        using errcode = '23514';
    end if;
  end loop;

  v_manifest_hash := encode(
    extensions.digest(convert_to(p_manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );
  select * into v_existing
  from public.generation_fixed_reference_snapshots s
  where s.job_id = p_job_id
  for update;
  if found then
    if v_existing.profile_id <> p_profile_id
      or v_existing.attempt_id <> p_attempt_id
      or v_existing.manifest_hash <> v_manifest_hash
      or v_existing.reference_hashes <>
        coalesce(p_reference_hashes, '{}'::text[])
      or v_existing.reference_kinds <>
        coalesce(p_reference_kinds, '{}'::text[])
      or v_existing.embedding_digests <>
        coalesce(p_embedding_digests, '{}'::text[]) then
      raise exception 'scene_fixed_reference_snapshot_conflict'
        using errcode = '23505';
    end if;
    return query select v_existing.id, v_existing.manifest_hash, true;
    return;
  end if;

  insert into public.generation_fixed_reference_snapshots (
    job_id, attempt_id, profile_id, manifest, manifest_hash,
    reference_hashes, reference_kinds, embedding_digests
  ) values (
    p_job_id, p_attempt_id, p_profile_id, p_manifest, v_manifest_hash,
    coalesce(p_reference_hashes, '{}'::text[]),
    coalesce(p_reference_kinds, '{}'::text[]),
    coalesce(p_embedding_digests, '{}'::text[])
  ) returning * into v_existing;

  return query select v_existing.id, v_existing.manifest_hash, false;
end;
$$;

revoke all on function public.record_scene_fixed_reference_snapshot(
  uuid, uuid, uuid, uuid, jsonb, text[], text[], text[]
) from public, anon, authenticated;
grant execute on function public.record_scene_fixed_reference_snapshot(
  uuid, uuid, uuid, uuid, jsonb, text[], text[], text[]
) to service_role;

alter table public.generation_provider_calls
  add column if not exists fixed_reference_snapshot_id uuid,
  add column if not exists fixed_reference_hashes text[]
    not null default '{}'::text[];

alter table public.generation_provider_calls
  drop constraint if exists generation_provider_calls_fixed_snapshot_fk;
alter table public.generation_provider_calls
  add constraint generation_provider_calls_fixed_snapshot_fk
  foreign key (fixed_reference_snapshot_id, job_id, profile_id)
  references public.generation_fixed_reference_snapshots(id, job_id, profile_id)
  deferrable initially deferred;

-- Replace the original unnamed concatenation check without depending on the
-- automatically generated constraint name.
do $$
declare
  v_constraint_name text;
begin
  for v_constraint_name in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.generation_provider_calls'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid)
        like '%reference_content_hashes =%aesthetic_reference_hashes%identity_reference_hashes%'
  loop
    execute format(
      'alter table public.generation_provider_calls drop constraint %I',
      v_constraint_name
    );
  end loop;
end;
$$;

alter table public.generation_provider_calls
  drop constraint if exists generation_provider_calls_reference_sets_v2_check;
alter table public.generation_provider_calls
  add constraint generation_provider_calls_reference_sets_v2_check check (
    cardinality(reference_content_hashes) between 3 and 12
    and cardinality(aesthetic_reference_hashes) = 3
    and cardinality(fixed_reference_hashes) between 0 and 6
    and cardinality(identity_reference_hashes) between 0 and 6
    and reference_content_hashes = aesthetic_reference_hashes
      || fixed_reference_hashes || identity_reference_hashes
  );
alter table public.generation_provider_calls
  drop constraint if exists generation_provider_calls_identity_not_evaluated;
alter table public.generation_provider_calls
  add constraint generation_provider_calls_identity_not_evaluated check (
    status not in ('copy_rejected', 'accepted')
    or matched_reference_kind <> 'identity'
  );

create or replace function public.reserve_scene_provider_call_v2(
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
  p_fixed_reference_snapshot_id uuid,
  p_fixed_reference_hashes text[],
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
  v_initial public.generation_provider_calls%rowtype;
  v_retrieved public.generation_reference_snapshots%rowtype;
  v_fixed public.generation_fixed_reference_snapshots%rowtype;
  v_purpose text;
  v_funding text;
  v_reference_content_hashes text[];
begin
  v_reference_content_hashes :=
    coalesce(p_aesthetic_reference_hashes, '{}'::text[])
    || coalesce(p_fixed_reference_hashes, '{}'::text[])
    || coalesce(p_identity_reference_hashes, '{}'::text[]);
  if p_call_index not in (0, 1)
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_reference_manifest_hash !~ '^[a-f0-9]{64}$'
    or cardinality(coalesce(p_aesthetic_reference_hashes, '{}'::text[])) <> 3
    or cardinality(coalesce(p_fixed_reference_hashes, '{}'::text[])) > 6
    or cardinality(coalesce(p_identity_reference_hashes, '{}'::text[])) > 6
    or cardinality(v_reference_content_hashes) not between 3 and 12
    or array_position(v_reference_content_hashes, null) is not null
    or cardinality(v_reference_content_hashes) <> cardinality(array(
      select distinct hashes.value
      from unnest(v_reference_content_hashes) as hashes(value)
    ))
    or exists (
      select 1 from unnest(v_reference_content_hashes) as hashes(value)
      where hashes.value !~ '^[a-f0-9]{64}$'
    )
    or p_fixed_reference_snapshot_id is null
    or nullif(p_provider, '') is null
    or length(p_provider) > 100
    or nullif(p_model_ref, '') is null
    or length(p_model_ref) > 200 then
    raise exception 'invalid_scene_provider_call_v2' using errcode = '22023';
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
  if v_job.id is null or v_attempt.id is null then
    raise exception 'generation_job_not_found' using errcode = 'P0002';
  end if;
  if v_job.status <> 'generating'
    or v_job.active_attempt_id is distinct from p_attempt_id
    or v_job.lease_token is distinct from p_lease_token
    or v_attempt.lease_token is distinct from p_lease_token
    or v_attempt.lease_expires_at <= now() then
    raise exception 'generation_lease_lost' using errcode = '40001';
  end if;

  select * into v_retrieved
  from public.generation_reference_snapshots s
  where s.job_id = p_job_id
    and s.profile_id = p_profile_id
    and s.attempt_id = p_attempt_id
    and s.candidate_index = p_call_index
    and s.manifest_hash = p_reference_manifest_hash
  for update;
  if not found
    or v_retrieved.aesthetic_reference_hashes <>
      coalesce(p_aesthetic_reference_hashes, '{}'::text[]) then
    raise exception 'generation_reference_snapshot_mismatch'
      using errcode = '23514';
  end if;

  select * into v_fixed
  from public.generation_fixed_reference_snapshots s
  where s.id = p_fixed_reference_snapshot_id
    and s.job_id = p_job_id
    and s.profile_id = p_profile_id
    and s.attempt_id = p_attempt_id
  for update;
  if not found
    or v_fixed.reference_hashes <>
      coalesce(p_fixed_reference_hashes, '{}'::text[]) then
    raise exception 'generation_fixed_reference_snapshot_mismatch'
      using errcode = '23514';
  end if;

  select * into v_existing
  from public.generation_provider_calls c
  where c.job_id = p_job_id and c.call_index = p_call_index
  for update;
  if found then
    if v_existing.attempt_id <> p_attempt_id
      or v_existing.profile_id <> p_profile_id
      or v_existing.provider <> p_provider
      or v_existing.model_ref <> p_model_ref
      or v_existing.request_hash <> p_request_hash
      or v_existing.reference_manifest_hash <> p_reference_manifest_hash
      or v_existing.aesthetic_reference_hashes <>
        coalesce(p_aesthetic_reference_hashes, '{}'::text[])
      or v_existing.fixed_reference_snapshot_id is distinct from
        p_fixed_reference_snapshot_id
      or v_existing.fixed_reference_hashes <>
        coalesce(p_fixed_reference_hashes, '{}'::text[])
      or v_existing.identity_reference_hashes <>
        coalesce(p_identity_reference_hashes, '{}'::text[]) then
      raise exception 'scene_provider_call_replay_conflict'
        using errcode = '23505';
    end if;
    return query select false, v_existing.id, v_existing.status,
      v_existing.funding_source;
    return;
  end if;

  if p_call_index = 1 then
    select * into v_initial
    from public.generation_provider_calls c
    where c.job_id = p_job_id
      and c.call_index = 0
      and c.status = 'copy_rejected'
    for update;
    if not found
      or v_initial.reference_manifest_hash = p_reference_manifest_hash
      or v_initial.aesthetic_reference_hashes &&
        coalesce(p_aesthetic_reference_hashes, '{}'::text[])
      or v_initial.fixed_reference_snapshot_id is distinct from
        p_fixed_reference_snapshot_id
      or v_initial.fixed_reference_hashes <>
        coalesce(p_fixed_reference_hashes, '{}'::text[])
      or v_initial.identity_reference_hashes <>
        coalesce(p_identity_reference_hashes, '{}'::text[]) then
      raise exception 'anti_copy_reroll_reference_contract_invalid'
        using errcode = '23514';
    end if;
  end if;

  v_purpose := case when p_call_index = 0
    then 'initial' else 'anti_copy_reroll' end;
  v_funding := case when p_call_index = 0
    then 'user_reserved' else 'system_anti_copy' end;
  insert into public.generation_provider_calls (
    id, job_id, attempt_id, profile_id, call_index, purpose,
    funding_source, provider, model_ref, request_hash,
    reference_manifest_hash, reference_content_hashes,
    aesthetic_reference_hashes, fixed_reference_snapshot_id,
    fixed_reference_hashes, identity_reference_hashes
  ) values (
    p_call_id, p_job_id, p_attempt_id, p_profile_id, p_call_index,
    v_purpose, v_funding, p_provider, p_model_ref, p_request_hash,
    p_reference_manifest_hash, v_reference_content_hashes,
    coalesce(p_aesthetic_reference_hashes, '{}'::text[]),
    p_fixed_reference_snapshot_id,
    coalesce(p_fixed_reference_hashes, '{}'::text[]),
    coalesce(p_identity_reference_hashes, '{}'::text[])
  ) returning * into v_existing;

  update public.generation_attempts a
  set lease_expires_at = now() + interval '5 minutes'
  where a.id = p_attempt_id and a.profile_id = p_profile_id;
  update public.generation_jobs j
  set lease_expires_at = now() + interval '5 minutes'
  where j.id = p_job_id and j.profile_id = p_profile_id;

  return query select true, v_existing.id, v_existing.status,
    v_existing.funding_source;
end;
$$;

revoke all on function public.reserve_scene_provider_call_v2(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text, text,
  text[], uuid, text[], text[]
) from public, anon, authenticated;
grant execute on function public.reserve_scene_provider_call_v2(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text, text,
  text[], uuid, text[], text[]
) to service_role;

-- The legacy internal reserve/authorize pair cannot express fixed-reference
-- evidence or bind a lease-protected accepted call. Keep the functions only
-- for migration history, but make the v2 contracts the sole executable path.
revoke execute on function public.reserve_scene_provider_call(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text, text, text[], text[]
) from service_role;
revoke execute on function public.authorize_scene_output_upload(
  uuid, uuid, uuid, uuid, text
) from service_role;

create or replace function public.prevent_scene_reference_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'sealed_scene_reference_snapshot_is_immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists generation_reference_snapshot_immutable
  on public.generation_reference_snapshots;
create trigger generation_reference_snapshot_immutable
before update on public.generation_reference_snapshots
for each row execute function public.prevent_scene_reference_snapshot_mutation();

drop trigger if exists generation_fixed_reference_snapshot_immutable
  on public.generation_fixed_reference_snapshots;
create trigger generation_fixed_reference_snapshot_immutable
before update on public.generation_fixed_reference_snapshots
for each row execute function public.prevent_scene_reference_snapshot_mutation();

create or replace function public.enforce_scene_accepted_provider_call()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.accepted_provider_call_id is not null
    and new.accepted_provider_call_id is distinct from old.accepted_provider_call_id then
    raise exception 'scene_accepted_provider_call_is_immutable'
      using errcode = '55000';
  end if;

  if new.accepted_provider_call_id is not null
    and new.accepted_provider_call_id is distinct from old.accepted_provider_call_id
    and not exists (
      select 1
      from public.generation_provider_calls c
      where c.id = new.accepted_provider_call_id
        and c.job_id = new.id
        and c.profile_id = new.profile_id
        and c.attempt_id = new.active_attempt_id
        and c.status = 'accepted'
    ) then
    raise exception 'scene_accepted_provider_call_invalid'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists generation_job_accepted_provider_call_guard
  on public.generation_jobs;
create trigger generation_job_accepted_provider_call_guard
before update of accepted_provider_call_id on public.generation_jobs
for each row execute function public.enforce_scene_accepted_provider_call();

create or replace function public.enforce_scene_output_matches_accepted_call()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pending_storage_path is null then
    return new;
  end if;

  if new.accepted_provider_call_id is null or not exists (
    select 1
    from public.generation_provider_calls c
    join public.generation_reference_snapshots r
      on r.job_id = c.job_id
      and r.profile_id = c.profile_id
      and r.attempt_id = c.attempt_id
      and r.candidate_index = c.call_index
      and r.manifest_hash = c.reference_manifest_hash
    join public.generation_fixed_reference_snapshots f
      on f.id = c.fixed_reference_snapshot_id
      and f.job_id = c.job_id
      and f.profile_id = c.profile_id
      and f.attempt_id = c.attempt_id
    where c.id = new.accepted_provider_call_id
      and c.job_id = new.id
      and c.profile_id = new.profile_id
      and c.attempt_id = new.active_attempt_id
      and c.status = 'accepted'
      and c.output_content_sha256 = new.pending_content_sha256
      and c.output_mime = new.pending_mime_type
      and c.output_width = new.pending_width
      and c.output_height = new.pending_height
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,provider_call_id}' = c.id::text
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,candidate_index}' =
          c.call_index::text
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,funding_source}' =
          c.funding_source
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,output_content_sha256}' =
          c.output_content_sha256
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,output_embedding_digest}' =
          c.output_embedding_digest
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,reference_snapshot_id}' =
          r.id::text
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,reference_manifest_hash}' =
          c.reference_manifest_hash
      and new.finalization_payload #>
        '{provenance,accepted_provider_call,retrieved_aesthetic_hashes}' =
          to_jsonb(c.aesthetic_reference_hashes)
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,fixed_reference_snapshot_id}' =
          f.id::text
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,fixed_reference_manifest_hash}' =
          f.manifest_hash
      and new.finalization_payload #>
        '{provenance,accepted_provider_call,fixed_reference_hashes}' =
          to_jsonb(f.reference_hashes)
      and new.finalization_payload #>
        '{provenance,accepted_provider_call,fixed_reference_embedding_digests}' =
          to_jsonb(f.embedding_digests)
      and new.finalization_payload #>
        '{provenance,accepted_provider_call,identity_reference_hashes}' =
          to_jsonb(c.identity_reference_hashes)
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,anti_copy_policy_version}' =
          c.anti_copy_policy_version
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,anti_copy_threshold}' =
          c.anti_copy_threshold::text
      and new.finalization_payload #>
        '{provenance,accepted_provider_call,maximum_similarity}' =
          to_jsonb(c.maximum_similarity)
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,matched_reference_kind}' =
          c.matched_reference_kind
      and new.finalization_payload #>>
        '{provenance,accepted_provider_call,matched_reference_sha256}' =
          c.matched_reference_sha256
  ) then
    raise exception 'scene_output_not_from_accepted_provider_call'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists generation_job_output_accepted_call_guard
  on public.generation_jobs;
create trigger generation_job_output_accepted_call_guard
before update of pending_storage_bucket, pending_storage_path,
  pending_mime_type, pending_width, pending_height, pending_content_sha256
on public.generation_jobs
for each row execute function public.enforce_scene_output_matches_accepted_call();

create or replace function public.authorize_scene_output_upload_v2(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_provider_call_id uuid,
  p_content_sha256 text
)
returns table (
  authorized boolean,
  provider_call_id uuid,
  candidate_index integer,
  reroll_used boolean,
  maximum_similarity double precision,
  matched_reference_kind text,
  matched_reference_sha256 text,
  reference_snapshot_id uuid,
  reference_manifest_hash text,
  retrieved_aesthetic_hashes text[],
  identity_reference_hashes text[],
  output_embedding_digest text,
  anti_copy_policy_version text,
  anti_copy_threshold double precision,
  fixed_reference_snapshot_id uuid,
  fixed_reference_manifest_hash text,
  fixed_reference_hashes text[],
  fixed_reference_embedding_digests text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_attempt public.generation_attempts%rowtype;
  v_call public.generation_provider_calls%rowtype;
  v_retrieved public.generation_reference_snapshots%rowtype;
  v_fixed public.generation_fixed_reference_snapshots%rowtype;
begin
  if p_content_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'scene_output_upload_hash_invalid' using errcode = '22023';
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
    and c.profile_id = p_profile_id
    and c.attempt_id = p_attempt_id
  for update;

  if v_job.id is null or v_attempt.id is null or v_call.id is null then
    raise exception 'scene_output_upload_not_authorized' using errcode = 'P0002';
  end if;
  select * into v_retrieved
  from public.generation_reference_snapshots r
  where r.job_id = p_job_id
    and r.profile_id = p_profile_id
    and r.attempt_id = p_attempt_id
    and r.candidate_index = v_call.call_index
    and r.manifest_hash = v_call.reference_manifest_hash;
  select * into v_fixed
  from public.generation_fixed_reference_snapshots f
  where f.id = v_call.fixed_reference_snapshot_id
    and f.job_id = p_job_id
    and f.profile_id = p_profile_id
    and f.attempt_id = p_attempt_id;
  if v_retrieved.id is null or v_fixed.id is null
    or v_fixed.reference_hashes <> v_call.fixed_reference_hashes then
    raise exception 'scene_output_reference_evidence_missing'
      using errcode = '23514';
  end if;
  if v_job.status <> 'generating'
    or v_job.active_attempt_id is distinct from p_attempt_id
    or v_job.lease_token is distinct from p_lease_token
    or v_attempt.lease_token is distinct from p_lease_token
    or v_attempt.lease_expires_at <= now()
    or v_call.status <> 'accepted'
    or v_call.output_content_sha256 is distinct from p_content_sha256 then
    raise exception 'scene_output_upload_not_authorized' using errcode = '40001';
  end if;
  if v_job.accepted_provider_call_id is not null
    and v_job.accepted_provider_call_id is distinct from p_provider_call_id then
    raise exception 'scene_accepted_provider_call_conflict' using errcode = '23505';
  end if;

  update public.generation_jobs j
  set accepted_provider_call_id = p_provider_call_id
  where j.id = p_job_id
    and j.profile_id = p_profile_id
    and j.accepted_provider_call_id is null;

  return query select
    true,
    v_call.id,
    v_call.call_index::integer,
    v_call.call_index = 1,
    v_call.maximum_similarity,
    v_call.matched_reference_kind,
    v_call.matched_reference_sha256,
    v_retrieved.id,
    v_call.reference_manifest_hash,
    v_call.aesthetic_reference_hashes,
    v_call.identity_reference_hashes,
    v_call.output_embedding_digest,
    v_call.anti_copy_policy_version,
    v_call.anti_copy_threshold,
    v_fixed.id,
    v_fixed.manifest_hash,
    v_fixed.reference_hashes,
    v_fixed.embedding_digests;
end;
$$;

revoke all on function public.authorize_scene_output_upload_v2(
  uuid, uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.authorize_scene_output_upload_v2(
  uuid, uuid, uuid, uuid, uuid, text
) to service_role;

-- An uncertain Storage response is not a charge boundary. Keep the reservation
-- open while the deterministic path is reconciled; record_scene_generation_output
-- alone consumes it after object existence and accepted-call evidence pass.
create or replace function public.mark_scene_generation_recoverable(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_error_code text default 'generation_output_record_deferred'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
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
  if v_job.status = 'indeterminate'
    and v_job.active_attempt_id = p_attempt_id
    and v_job.lease_token = p_lease_token then
    return true;
  end if;
  if v_job.status <> 'generating'
    or v_job.active_attempt_id is distinct from p_attempt_id
    or v_job.lease_token is distinct from p_lease_token then
    return false;
  end if;

  update public.generation_attempts a
  set status = 'indeterminate',
      error_code = left(
        coalesce(p_error_code, 'generation_output_record_deferred'),
        120
      ),
      error_detail =
        'An accepted deterministic output may exist and must be reconciled before retry.',
      completed_at = now()
  where a.id = p_attempt_id
    and a.job_id = p_job_id
    and a.profile_id = p_profile_id
    and a.lease_token = p_lease_token
    and a.status = 'started';

  update public.generation_jobs j
  set status = 'indeterminate',
      error_code = left(
        coalesce(p_error_code, 'generation_output_record_deferred'),
        120
      ),
      error_detail =
        'An accepted deterministic output may exist and must be reconciled before retry.',
      lease_expires_at = null,
      completed_at = now()
  where j.id = p_job_id and j.status = 'generating';

  -- Deliberately leave credit_reservations.status = 'reserved'.
  return true;
end;
$$;

comment on column public.generation_jobs.accepted_provider_call_id is
  'Immutable accepted provider call whose exact MIME, dimensions, and SHA-256 authorize the pending output.';
