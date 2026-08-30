-- Explicit owner rights/conditioning assertions for user-uploaded inspiration.
-- Clients cannot mutate rights fields directly; the authenticated Edge handler
-- records this append-only audit evidence through one service-only transaction.

begin;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.inspiration_assets'::regclass
      and conname = 'inspiration_assets_id_profile_unique'
  ) then
    alter table public.inspiration_assets
      add constraint inspiration_assets_id_profile_unique
      unique (id, profile_id);
  end if;
end;
$migration$;

create table if not exists public.inspiration_rights_attestations (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null,
  asset_id uuid not null,
  idempotency_key text not null check (
    char_length(idempotency_key) between 8 and 200
  ),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  rights_basis text not null check (rights_basis in ('owned', 'licensed')),
  conditioning_authorized boolean not null check (conditioning_authorized),
  policy_version text not null check (
    policy_version = 'conditioning-rights-v1'
  ),
  asset_storage_path text not null check (
    char_length(asset_storage_path) between 1 and 1024
  ),
  attested_at timestamptz not null default now(),
  unique (profile_id, idempotency_key, asset_id),
  foreign key (asset_id, profile_id)
    references public.inspiration_assets(id, profile_id)
    on delete cascade
);

create index if not exists inspiration_rights_attestations_owner_time_idx
  on public.inspiration_rights_attestations (profile_id, attested_at desc);

alter table public.inspiration_rights_attestations enable row level security;
drop policy if exists "inspiration rights attestations: owner read"
  on public.inspiration_rights_attestations;
create policy "inspiration rights attestations: owner read"
  on public.inspiration_rights_attestations
  for select to authenticated
  using ((select auth.uid()) = profile_id);

revoke all on public.inspiration_rights_attestations
  from public, anon, authenticated, service_role;
grant select on public.inspiration_rights_attestations to authenticated;

create or replace function public.attest_inspiration_asset_rights(
  p_profile_id uuid,
  p_idempotency_key text,
  p_attestations jsonb
)
returns table (
  attestation_id uuid,
  asset_id uuid,
  rights_basis text,
  conditioning_authorized boolean,
  policy_version text,
  replayed boolean,
  attested_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.inspiration_assets%rowtype;
  v_item jsonb;
  v_asset_id uuid;
  v_previous_asset_id uuid;
  v_count integer;
  v_existing_count integer;
  v_existing_min_hash text;
  v_existing_max_hash text;
  v_request_hash text;
begin
  if p_profile_id is null
    or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 8 and 200
    or jsonb_typeof(p_attestations) is distinct from 'array' then
    raise exception 'invalid_inspiration_rights_attestation'
      using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_attestations);
  if v_count not between 1 and 16 then
    raise exception 'invalid_inspiration_rights_attestation_count'
      using errcode = '22023';
  end if;

  -- The Edge handler sends this canonical order, which makes both identity and
  -- idempotency independent of client object-key order.
  for v_item in select value from jsonb_array_elements(p_attestations)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(v_item)) <> 4
      or not (
        v_item ? 'assetId'
        and v_item ? 'rightsBasis'
        and v_item ? 'conditioningAuthorized'
        and v_item ? 'policyVersion'
      )
      or coalesce(v_item ->> 'assetId', '') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(v_item ->> 'rightsBasis', '') not in ('owned', 'licensed')
      or v_item -> 'conditioningAuthorized' is distinct from 'true'::jsonb
      or v_item ->> 'policyVersion' is distinct from
        'conditioning-rights-v1' then
      raise exception 'invalid_inspiration_rights_attestation_item'
        using errcode = '22023';
    end if;
    v_asset_id := (v_item ->> 'assetId')::uuid;
    if v_previous_asset_id is not null and v_asset_id <= v_previous_asset_id then
      raise exception 'inspiration_rights_attestations_not_canonical'
        using errcode = '22023';
    end if;
    v_previous_asset_id := v_asset_id;
  end loop;

  v_request_hash := encode(
    extensions.digest(convert_to(p_attestations::text, 'UTF8'), 'sha256'),
    'hex'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_profile_id::text || ':' || p_idempotency_key,
      0
    )
  );

  select count(*), min(a.request_hash), max(a.request_hash)
  into v_existing_count, v_existing_min_hash, v_existing_max_hash
  from public.inspiration_rights_attestations a
  where a.profile_id = p_profile_id
    and a.idempotency_key = p_idempotency_key;
  if v_existing_count > 0 then
    if v_existing_count <> v_count
      or v_existing_min_hash is distinct from v_request_hash
      or v_existing_max_hash is distinct from v_request_hash then
      raise exception 'inspiration_rights_attestation_idempotency_conflict'
        using errcode = '23505';
    end if;
    return query
    select
      a.id,
      a.asset_id,
      a.rights_basis,
      a.conditioning_authorized,
      a.policy_version,
      true,
      a.attested_at
    from public.inspiration_rights_attestations a
    where a.profile_id = p_profile_id
      and a.idempotency_key = p_idempotency_key
    order by a.asset_id;
    return;
  end if;

  -- Validate and lock the entire batch before any audit or eligibility write.
  for v_item in select value from jsonb_array_elements(p_attestations)
  loop
    v_asset_id := (v_item ->> 'assetId')::uuid;
    select * into v_asset
    from public.inspiration_assets a
    where a.id = v_asset_id
    for update;
    if not found
      or v_asset.profile_id is distinct from p_profile_id
      or v_asset.source is distinct from 'user_upload' then
      raise exception 'inspiration_rights_attestation_forbidden'
        using errcode = '42501';
    end if;
    if v_asset.rights not in ('unverified', 'owned', 'licensed')
      or (
        v_asset.rights <> 'unverified'
        and v_asset.rights is distinct from (v_item ->> 'rightsBasis')
      ) then
      raise exception 'inspiration_rights_basis_conflict'
        using errcode = '23505';
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_attestations)
  loop
    v_asset_id := (v_item ->> 'assetId')::uuid;
    update public.inspiration_assets a
    set rights = v_item ->> 'rightsBasis',
        usable_for_conditioning = true
    where a.id = v_asset_id and a.profile_id = p_profile_id;

    insert into public.inspiration_rights_attestations (
      profile_id,
      asset_id,
      idempotency_key,
      request_hash,
      rights_basis,
      conditioning_authorized,
      policy_version,
      asset_storage_path
    ) values (
      p_profile_id,
      v_asset_id,
      p_idempotency_key,
      v_request_hash,
      v_item ->> 'rightsBasis',
      true,
      v_item ->> 'policyVersion',
      (select a.storage_path from public.inspiration_assets a
        where a.id = v_asset_id)
    );
  end loop;

  return query
  select
    a.id,
    a.asset_id,
    a.rights_basis,
    a.conditioning_authorized,
    a.policy_version,
    false,
    a.attested_at
  from public.inspiration_rights_attestations a
  where a.profile_id = p_profile_id
    and a.idempotency_key = p_idempotency_key
  order by a.asset_id;
end;
$$;

revoke all on function public.attest_inspiration_asset_rights(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.attest_inspiration_asset_rights(
  uuid, text, jsonb
) to service_role;

-- A licensed owner upload carries the same explicit conditioning assertion as
-- an owned upload. Keep the generation-time provenance gate aligned with the
-- indexing gate while preserving the separate licensed style-pack rule.
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
          and v_asset.rights in ('owned', 'licensed')
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

comment on table public.inspiration_rights_attestations is
  'Append-only server-recorded owner assertions; removed only with the owning inspiration asset/account cascade.';
comment on function public.attest_inspiration_asset_rights(uuid, text, jsonb) is
  'Atomically audits owned/licensed conditioning authorization and makes owner user_upload assets index-eligible.';

commit;
