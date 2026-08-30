-- Immutable retrieval snapshot bound to each image-provider candidate. Replays
-- reuse this ordered selection even if the live reference index later changes.

create table if not exists public.generation_reference_snapshots (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  attempt_id uuid not null,
  profile_id uuid not null,
  candidate_index smallint not null check (candidate_index in (0, 1)),
  prompt_hash text not null check (prompt_hash ~ '^[a-f0-9]{64}$'),
  embedding_input_hash text not null
    check (embedding_input_hash ~ '^[a-f0-9]{64}$'),
  embedding_model text not null default 'gemini-embedding-2'
    check (embedding_model = 'gemini-embedding-2'),
  retrieval_policy_version text not null default 'reference-retrieval-v1'
    check (retrieval_policy_version = 'reference-retrieval-v1'),
  rights_policy_version text not null default 'conditioning-rights-v1'
    check (rights_policy_version = 'conditioning-rights-v1'),
  style_pack_id text,
  manifest jsonb not null,
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  aesthetic_reference_hashes text[] not null,
  identity_reference_hashes text[] not null default '{}'::text[],
  selected_asset_ids uuid[] not null,
  selected_conditioning_hashes text[] not null,
  selection_evidence jsonb not null,
  created_at timestamptz not null default now(),
  unique (job_id, candidate_index),
  unique (job_id, profile_id, manifest_hash),
  foreign key (job_id, profile_id)
    references public.generation_jobs(id, profile_id)
    on delete cascade,
  foreign key (attempt_id, profile_id)
    references public.generation_attempts(id, profile_id)
    on delete cascade,
  check (cardinality(aesthetic_reference_hashes) between 3 and 12),
  check (cardinality(identity_reference_hashes) between 0 and 6),
  check (cardinality(selected_asset_ids) = 3),
  check (cardinality(selected_conditioning_hashes) = 3),
  check (selected_conditioning_hashes <@ aesthetic_reference_hashes)
);

alter table public.generation_reference_snapshots enable row level security;
revoke all on public.generation_reference_snapshots from public, anon, authenticated;

create or replace function public.record_scene_reference_snapshot(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_candidate_index integer,
  p_prompt_hash text,
  p_embedding_input_hash text,
  p_style_pack_id text,
  p_manifest jsonb,
  p_aesthetic_reference_hashes text[],
  p_identity_reference_hashes text[],
  p_selected_asset_ids uuid[],
  p_selected_conditioning_hashes text[],
  p_selection_evidence jsonb
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
  v_existing public.generation_reference_snapshots%rowtype;
  v_initial public.generation_reference_snapshots%rowtype;
  v_manifest_hash text;
  v_all_hashes text[];
begin
  v_all_hashes :=
    coalesce(p_aesthetic_reference_hashes, '{}'::text[])
    || coalesce(p_identity_reference_hashes, '{}'::text[]);

  if p_candidate_index not in (0, 1)
    or p_prompt_hash !~ '^[a-f0-9]{64}$'
    or p_embedding_input_hash !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_manifest) <> 'object'
    or octet_length(p_manifest::text) > 65536
    or jsonb_typeof(p_selection_evidence) <> 'array'
    or octet_length(p_selection_evidence::text) > 32768
    or cardinality(coalesce(p_aesthetic_reference_hashes, '{}'::text[]))
      not between 3 and 12
    or cardinality(coalesce(p_identity_reference_hashes, '{}'::text[])) > 6
    or cardinality(v_all_hashes) <>
      cardinality(array(
        select distinct hashes.value
        from unnest(v_all_hashes) as hashes(value)
      ))
    or exists (
      select 1 from unnest(v_all_hashes) as hashes(value)
      where hashes.value !~ '^[a-f0-9]{64}$'
    )
    or cardinality(p_selected_asset_ids) <> 3
    or cardinality(p_selected_asset_ids) <>
      cardinality(array(
        select distinct asset_id
        from unnest(p_selected_asset_ids) as assets(asset_id)
      ))
    or cardinality(p_selected_conditioning_hashes) <> 3
    or cardinality(p_selected_conditioning_hashes) <>
      cardinality(array(
        select distinct hashes.value
        from unnest(p_selected_conditioning_hashes) as hashes(value)
      ))
    or not (p_selected_conditioning_hashes <@
      coalesce(p_aesthetic_reference_hashes, '{}'::text[])) then
    raise exception 'invalid_generation_reference_snapshot'
      using errcode = '22023';
  end if;

  if p_style_pack_id is not null and (
    length(p_style_pack_id) > 80
    or p_style_pack_id !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'
  ) then
    raise exception 'invalid_style_pack_id' using errcode = '22023';
  end if;

  v_manifest_hash := encode(
    extensions.digest(convert_to(p_manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );

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
    or v_job.active_attempt_id <> p_attempt_id
    or v_attempt.lease_token <> p_lease_token
    or v_attempt.lease_expires_at <= now() then
    raise exception 'generation_lease_lost' using errcode = '40001';
  end if;

  select * into v_existing
  from public.generation_reference_snapshots s
  where s.job_id = p_job_id and s.candidate_index = p_candidate_index
  for update;
  if found then
    if v_existing.manifest_hash <> v_manifest_hash
      or v_existing.prompt_hash <> p_prompt_hash
      or v_existing.embedding_input_hash <> p_embedding_input_hash then
      raise exception 'generation_reference_snapshot_conflict'
        using errcode = '23505';
    end if;
    return query select v_existing.id, v_existing.manifest_hash, true;
    return;
  end if;

  if p_candidate_index = 1 then
    select * into v_initial
    from public.generation_reference_snapshots s
    where s.job_id = p_job_id and s.candidate_index = 0
    for update;
    if not found then
      raise exception 'initial_reference_snapshot_missing' using errcode = '23514';
    end if;
    if v_initial.manifest_hash = v_manifest_hash
      or v_initial.aesthetic_reference_hashes &&
        coalesce(p_aesthetic_reference_hashes, '{}'::text[]) then
      raise exception 'anti_copy_reroll_reused_references'
        using errcode = '23514';
    end if;
  end if;

  insert into public.generation_reference_snapshots (
    job_id,
    attempt_id,
    profile_id,
    candidate_index,
    prompt_hash,
    embedding_input_hash,
    style_pack_id,
    manifest,
    manifest_hash,
    aesthetic_reference_hashes,
    identity_reference_hashes,
    selected_asset_ids,
    selected_conditioning_hashes,
    selection_evidence
  ) values (
    p_job_id,
    p_attempt_id,
    p_profile_id,
    p_candidate_index,
    p_prompt_hash,
    p_embedding_input_hash,
    nullif(p_style_pack_id, ''),
    p_manifest,
    v_manifest_hash,
    coalesce(p_aesthetic_reference_hashes, '{}'::text[]),
    coalesce(p_identity_reference_hashes, '{}'::text[]),
    p_selected_asset_ids,
    p_selected_conditioning_hashes,
    p_selection_evidence
  )
  returning * into v_existing;

  return query select v_existing.id, v_existing.manifest_hash, false;
end;
$$;

revoke all on function public.record_scene_reference_snapshot(
  uuid, uuid, uuid, uuid, integer, text, text, text, jsonb, text[], text[],
  uuid[], text[], jsonb
) from public, anon, authenticated;

grant execute on function public.record_scene_reference_snapshot(
  uuid, uuid, uuid, uuid, integer, text, text, text, jsonb, text[], text[],
  uuid[], text[], jsonb
) to service_role;

comment on table public.generation_reference_snapshots is
  'Immutable, rights-versioned ordered reference selection used for an idempotent scene candidate.';

