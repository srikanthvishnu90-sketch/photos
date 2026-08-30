-- Close the remaining reference-index lifecycle races without rewriting the
-- original migration. Asset claims are leased, run reservation binds every
-- manifest item atomically, provider-call reservation revalidates live rights
-- and immutable hashes, and terminal failure recording is replay-safe.

begin;

alter table public.inspiration_assets
  add column if not exists reference_index_run_id uuid,
  add column if not exists reference_index_claimed_at timestamptz,
  add column if not exists reference_index_claim_expires_at timestamptz;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_reference_index_run_fk;
alter table public.inspiration_assets
  add constraint inspiration_assets_reference_index_run_fk
  foreign key (reference_index_run_id)
  references public.reference_index_runs(id)
  on delete set null
  not valid;
alter table public.inspiration_assets
  validate constraint inspiration_assets_reference_index_run_fk;

create or replace function public.maintain_reference_index_asset_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.index_status = 'indexing' then
    if new.reference_index_run_id is null then
      if old.index_status is distinct from 'indexing'
        or old.reference_index_run_id is not null
        or new.reference_index_claimed_at is null then
        new.reference_index_claimed_at := now();
      end if;
      if new.reference_index_claim_expires_at is null then
        new.reference_index_claim_expires_at := now() + interval '15 minutes';
      end if;
    else
      new.reference_index_claimed_at := coalesce(
        new.reference_index_claimed_at,
        old.reference_index_claimed_at,
        now()
      );
      new.reference_index_claim_expires_at := null;
    end if;
  elsif new.index_status = 'ready' and new.reference_index_run_id is not null then
    new.reference_index_claimed_at := coalesce(
      new.reference_index_claimed_at,
      old.reference_index_claimed_at,
      now()
    );
    new.reference_index_claim_expires_at := null;
  else
    new.reference_index_run_id := null;
    new.reference_index_claimed_at := null;
    new.reference_index_claim_expires_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.maintain_reference_index_asset_claim()
  from public, anon, authenticated;

drop trigger if exists inspiration_asset_reference_index_claim_shape
  on public.inspiration_assets;
create trigger inspiration_asset_reference_index_claim_shape
before update on public.inspiration_assets
for each row execute function public.maintain_reference_index_asset_claim();

-- Existing direct handler claims become short-lived provisional claims. They
-- are either atomically adopted by reserve_reference_index_run or reaped.
update public.inspiration_assets
set reference_index_claimed_at = coalesce(reference_index_claimed_at, now()),
    reference_index_claim_expires_at = coalesce(
      reference_index_claim_expires_at,
      now() + interval '15 minutes'
    )
where index_status = 'indexing'
  and reference_index_run_id is null;

-- Forward-upgrade active runs only when an asset belongs to exactly one active
-- run and the original manifest already contains the v1 conditioning fields.
with active_bindings as (
  select
    i.asset_id,
    min(i.run_id::text)::uuid as run_id,
    min(i.content_sha256) as content_sha256,
    min(i.conditioning_sha256) as conditioning_sha256,
    min(i.mime_type) as mime_type,
    min(i.byte_size) as byte_size,
    min(m.item ->> 'conditioningStoragePath') as conditioning_storage_path
  from public.reference_index_run_items i
  join public.reference_index_runs r on r.id = i.run_id
  join lateral (
    select value as item
    from jsonb_array_elements(r.request_manifest -> 'assets')
    where value ->> 'assetId' = i.asset_id::text
  ) m on true
  where r.status in ('reserved', 'processing')
    and m.item ->> 'conditioningStorageBucket' = 'inspiration-conditioning'
    and nullif(m.item ->> 'conditioningStoragePath', '') is not null
  group by i.asset_id
  having count(*) = 1
)
update public.inspiration_assets a
set reference_index_run_id = b.run_id,
    reference_index_claimed_at = coalesce(a.reference_index_claimed_at, now()),
    reference_index_claim_expires_at = null,
    content_sha256 = b.content_sha256,
    conditioning_sha256 = b.conditioning_sha256,
    conditioning_storage_bucket = 'inspiration-conditioning',
    conditioning_storage_path = b.conditioning_storage_path,
    mime_type = b.mime_type,
    byte_size = b.byte_size
from active_bindings b
where a.id = b.asset_id
  and a.index_status = 'indexing'
  and a.reference_index_run_id is null;

alter table public.inspiration_assets
  drop constraint if exists inspiration_assets_reference_index_claim_shape;
alter table public.inspiration_assets
  add constraint inspiration_assets_reference_index_claim_shape check (
    (
      index_status = 'indexing'
      and reference_index_claimed_at is not null
      and (
        (
          reference_index_run_id is null
          and reference_index_claim_expires_at is not null
        )
        or
        (
          reference_index_run_id is not null
          and reference_index_claim_expires_at is null
        )
      )
    )
    or
    (
      index_status = 'ready'
      and reference_index_claim_expires_at is null
      and (
        (
          reference_index_run_id is null
          and reference_index_claimed_at is null
        )
        or
        (
          reference_index_run_id is not null
          and reference_index_claimed_at is not null
        )
      )
    )
    or
    (
      index_status in ('pending', 'failed')
      and reference_index_run_id is null
      and reference_index_claimed_at is null
      and reference_index_claim_expires_at is null
    )
  ) not valid;
alter table public.inspiration_assets
  validate constraint inspiration_assets_reference_index_claim_shape;

create index if not exists inspiration_assets_reference_index_run_idx
  on public.inspiration_assets (reference_index_run_id)
  where reference_index_run_id is not null;
create index if not exists inspiration_assets_reference_index_orphan_idx
  on public.inspiration_assets (reference_index_claim_expires_at, id)
  where index_status = 'indexing' and reference_index_run_id is null;
create index if not exists reference_index_reserved_recovery_idx
  on public.reference_index_runs (updated_at, id)
  where status = 'reserved';

create or replace function public.reserve_reference_index_run(
  p_requested_by uuid,
  p_idempotency_key text,
  p_request_manifest jsonb,
  p_indexing_version text
)
returns table (
  run_id uuid,
  run_status text,
  replayed boolean,
  request_hash text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.reference_index_runs%rowtype;
  v_asset public.inspiration_assets%rowtype;
  v_hash text;
  v_asset_count integer;
  v_item jsonb;
  v_asset_id uuid;
  v_owner_id uuid;
  v_owner_text text;
  v_source text;
  v_rights text;
  v_mime text;
  v_extension text;
  v_expected_conditioning_path text;
  v_previous_asset_id uuid;
  v_ordinal integer := 0;
  v_updated integer;
begin
  if p_requested_by is null then
    raise exception 'requested_by_required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or length(p_idempotency_key) < 8
    or length(p_idempotency_key) > 200 then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_indexing_version is null
    or length(p_indexing_version) < 1
    or length(p_indexing_version) > 100 then
    raise exception 'invalid_indexing_version' using errcode = '22023';
  end if;
  if jsonb_typeof(p_request_manifest) is distinct from 'object'
    or p_request_manifest ->> 'schema' is distinct from
      'reference-index-request-v1'
    or coalesce(p_request_manifest ->> 'requestMode', '') not in
      ('asset_ids', 'backfill')
    or p_request_manifest ->> 'embeddingModel' is distinct from
      'gemini-embedding-2'
    or nullif(p_request_manifest ->> 'visionModel', '') is null
    or length(p_request_manifest ->> 'visionModel') > 200
    or p_request_manifest ->> 'visionPromptVersion' is distinct from
      'reference-vision-look-v1'
    or p_request_manifest ->> 'retrievalDocumentVersion' is distinct from
      'reference-retrieval-document-v1'
    or p_request_manifest ->> 'rightsPolicyVersion' is distinct from
      'conditioning-rights-v1'
    or jsonb_typeof(p_request_manifest -> 'requestedAssetIds') is distinct from
      'array'
    or jsonb_typeof(p_request_manifest -> 'assets') is distinct from 'array' then
    raise exception 'invalid_reference_manifest' using errcode = '22023';
  end if;

  -- Both arrays are part of the request hash. Reject alternate spellings,
  -- duplicate requested IDs, and non-canonical ordering at the DB boundary.
  if exists (
      select 1
      from jsonb_array_elements(p_request_manifest -> 'requestedAssetIds') q
      where jsonb_typeof(q.value) is distinct from 'string'
        or coalesce(q.value #>> '{}', '') !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or p_request_manifest -> 'requestedAssetIds' is distinct from coalesce((
      select jsonb_agg(to_jsonb(ids.asset_id) order by ids.asset_id)
      from (
        select distinct q.value #>> '{}' as asset_id
        from jsonb_array_elements(
          p_request_manifest -> 'requestedAssetIds'
        ) q
      ) ids
    ), '[]'::jsonb) then
    raise exception 'reference_manifest_requested_ids_not_canonical'
      using errcode = '22023';
  end if;

  v_asset_count := jsonb_array_length(p_request_manifest -> 'assets');
  if v_asset_count < 1 or v_asset_count > 16 then
    raise exception 'invalid_reference_count' using errcode = '22023';
  end if;

  v_hash := encode(
    extensions.digest(
      convert_to(p_request_manifest::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- Serialize same-owner idempotency keys before looking up or inserting.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_requested_by::text || ':' || p_idempotency_key,
      0
    )
  );

  select * into v_run
  from public.reference_index_runs r
  where r.requested_by = p_requested_by
    and r.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_run.request_hash <> v_hash
      or v_run.indexing_version <> p_indexing_version then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    return query select v_run.id, v_run.status, true, v_run.request_hash;
    return;
  end if;

  -- Lock and validate every live asset before creating any run/item row.
  for v_item in
    select value
    from jsonb_array_elements(p_request_manifest -> 'assets')
  loop
    if jsonb_typeof(v_item) <> 'object'
      or coalesce(v_item ->> 'assetId', '') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(v_item ->> 'contentSha256', '') !~ '^[a-f0-9]{64}$'
      or coalesce(v_item ->> 'conditioningSha256', '') !~ '^[a-f0-9]{64}$'
      or coalesce(v_item ->> 'mimeType', '') not in ('image/jpeg', 'image/png')
      or coalesce(v_item ->> 'conditioningStorageBucket', '') <>
        'inspiration-conditioning'
      or coalesce(v_item ->> 'byteSize', '') !~ '^[0-9]+$'
      or (v_item ->> 'byteSize')::bigint not between 1 and 4194304
      or v_item -> 'usableForConditioning' is distinct from 'true'::jsonb then
      raise exception 'invalid_reference_manifest_item' using errcode = '22023';
    end if;

    v_asset_id := (v_item ->> 'assetId')::uuid;
    if v_previous_asset_id is not null and v_asset_id <= v_previous_asset_id then
      raise exception 'reference_manifest_assets_not_canonical'
        using errcode = '22023';
    end if;
    v_previous_asset_id := v_asset_id;

    v_source := v_item ->> 'source';
    v_rights := v_item ->> 'rights';
    v_mime := v_item ->> 'mimeType';
    v_owner_text := v_item ->> 'ownerProfileId';
    if v_source = 'user_upload' then
      if coalesce(v_owner_text, '') !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or v_item ->> 'stylePackId' is not null then
        raise exception 'invalid_reference_owner_shape' using errcode = '22023';
      end if;
      v_owner_id := v_owner_text::uuid;
    elsif v_source = 'style_pack' then
      if v_owner_text is not null
        or length(coalesce(v_item ->> 'stylePackId', '')) not between 1 and 80 then
        raise exception 'invalid_reference_owner_shape' using errcode = '22023';
      end if;
      v_owner_id := null;
    else
      raise exception 'invalid_reference_source' using errcode = '22023';
    end if;
    if coalesce(v_rights, '') not in ('owned', 'licensed') then
      raise exception 'reference_rights_not_eligible' using errcode = '42501';
    end if;

    v_extension := case when v_mime = 'image/jpeg' then 'jpg' else 'png' end;
    v_expected_conditioning_path := case when v_source = 'style_pack'
      then 'style-pack/' || v_asset_id::text || '/' ||
        (v_item ->> 'conditioningSha256') || '.' || v_extension
      else v_owner_id::text || '/reference/' || v_asset_id::text || '/' ||
        (v_item ->> 'conditioningSha256') || '.' || v_extension
    end;
    if v_item ->> 'conditioningStoragePath' is distinct from
      v_expected_conditioning_path then
      raise exception 'reference_conditioning_path_mismatch'
        using errcode = '23514';
    end if;

    select * into v_asset
    from public.inspiration_assets a
    where a.id = v_asset_id
    for update;
    if not found then
      raise exception 'reference_asset_not_found' using errcode = 'P0002';
    end if;
    if v_asset.profile_id is distinct from v_owner_id
      or v_asset.storage_path is distinct from v_item ->> 'storagePath'
      or v_asset.source is distinct from v_source
      or v_asset.style_pack_id is distinct from (v_item ->> 'stylePackId')
      or v_asset.rights is distinct from v_rights
      or not v_asset.usable_for_conditioning then
      raise exception 'reference_asset_rights_or_owner_mismatch'
        using errcode = '42501';
    end if;
    if v_asset.reference_index_run_id is not null then
      raise exception 'reference_asset_already_claimed' using errcode = '40001';
    end if;
    if v_asset.index_status = 'indexing' then
      if v_asset.reference_index_claim_expires_at is null
        or v_asset.reference_index_claim_expires_at <= now() then
        raise exception 'reference_asset_provisional_claim_expired'
          using errcode = '40001';
      end if;
    elsif v_asset.index_status not in ('pending', 'failed') then
      raise exception 'reference_asset_not_claimable' using errcode = '40001';
    end if;
    if v_asset.embedding is not null or v_asset.visual_embedding is not null
      or (
        v_asset.content_sha256 is not null
        and v_asset.content_sha256 <> v_item ->> 'contentSha256'
      )
      or (
        v_asset.conditioning_sha256 is not null
        and v_asset.conditioning_sha256 <> v_item ->> 'conditioningSha256'
      )
      or (
        v_asset.conditioning_storage_path is not null
        and v_asset.conditioning_storage_path <>
          v_item ->> 'conditioningStoragePath'
      ) then
      raise exception 'reference_asset_content_conflict' using errcode = '23505';
    end if;
  end loop;

  insert into public.reference_index_runs (
    requested_by,
    idempotency_key,
    request_manifest,
    request_hash,
    indexing_version,
    asset_count,
    expected_visual_embedding_calls
  ) values (
    p_requested_by,
    p_idempotency_key,
    p_request_manifest,
    v_hash,
    p_indexing_version,
    v_asset_count,
    ceiling(v_asset_count::numeric / 6)::integer
  )
  returning * into v_run;

  v_ordinal := 0;
  for v_item in
    select value
    from jsonb_array_elements(p_request_manifest -> 'assets')
  loop
    v_asset_id := (v_item ->> 'assetId')::uuid;
    insert into public.reference_index_run_items (
      run_id,
      asset_id,
      ordinal,
      content_sha256,
      conditioning_sha256,
      mime_type,
      byte_size
    ) values (
      v_run.id,
      v_asset_id,
      v_ordinal,
      v_item ->> 'contentSha256',
      v_item ->> 'conditioningSha256',
      v_item ->> 'mimeType',
      (v_item ->> 'byteSize')::bigint
    );

    update public.inspiration_assets
    set index_status = 'indexing',
        index_error = null,
        indexing_version = p_indexing_version,
        embedding = null,
        visual_embedding = null,
        indexed_at = null,
        content_sha256 = v_item ->> 'contentSha256',
        conditioning_sha256 = v_item ->> 'conditioningSha256',
        conditioning_storage_bucket = v_item ->> 'conditioningStorageBucket',
        conditioning_storage_path = v_item ->> 'conditioningStoragePath',
        mime_type = v_item ->> 'mimeType',
        byte_size = (v_item ->> 'byteSize')::bigint,
        reference_index_run_id = v_run.id,
        reference_index_claimed_at = now(),
        reference_index_claim_expires_at = null
    where id = v_asset_id
      and reference_index_run_id is null;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      raise exception 'reference_asset_claim_race' using errcode = '40001';
    end if;
    v_ordinal := v_ordinal + 1;
  end loop;

  return query select v_run.id, v_run.status, false, v_run.request_hash;
end;
$$;

create or replace function public.claim_reference_index_run(
  p_run_id uuid,
  p_requested_by uuid,
  p_lease_seconds integer default 600
)
returns table (
  claimed boolean,
  run_status text,
  attempt_number integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.reference_index_runs%rowtype;
  v_token uuid;
  v_valid_assets integer;
begin
  if p_lease_seconds is null
    or p_lease_seconds < 120 or p_lease_seconds > 900 then
    raise exception 'invalid_lease_duration' using errcode = '22023';
  end if;

  select * into v_run
  from public.reference_index_runs r
  where r.id = p_run_id and r.requested_by = p_requested_by
  for update;
  if not found then
    raise exception 'reference_index_run_not_found' using errcode = 'P0002';
  end if;

  if v_run.status in ('completed', 'failed', 'indeterminate') then
    return query select false, v_run.status, v_run.attempt_number,
      v_run.lease_token, v_run.lease_expires_at;
    return;
  end if;
  if v_run.status = 'processing' and v_run.lease_expires_at > now() then
    return query select false, v_run.status, v_run.attempt_number,
      v_run.lease_token, v_run.lease_expires_at;
    return;
  end if;

  if v_run.status = 'processing' and exists (
    select 1
    from public.reference_index_provider_calls c
    where c.run_id = v_run.id and c.status = 'prepared'
  ) then
    update public.reference_index_provider_calls
    set status = 'indeterminate',
        billing_state = 'unknown',
        error_code = 'provider_outcome_unknown',
        error_detail = 'lease expired after provider call preparation',
        provider_completed_at = now(),
        updated_at = now()
    where run_id = v_run.id and status = 'prepared';

    update public.reference_index_runs
    set status = 'indeterminate',
        lease_token = null,
        lease_expires_at = null,
        error_code = 'provider_outcome_unknown',
        error_detail = 'lease expired after a provider call was prepared',
        completed_at = now(),
        updated_at = now()
    where id = v_run.id;

    update public.inspiration_assets
    set index_status = 'failed',
        index_error = 'provider_outcome_unknown',
        reference_index_run_id = null,
        reference_index_claimed_at = null,
        reference_index_claim_expires_at = null
    where reference_index_run_id = v_run.id;

    return query select false, 'indeterminate'::text,
      v_run.attempt_number, null::uuid, null::timestamptz;
    return;
  end if;

  select count(*) into v_valid_assets
  from public.reference_index_run_items i
  join public.inspiration_assets a on a.id = i.asset_id
  where i.run_id = v_run.id
    and a.reference_index_run_id = v_run.id
    and a.index_status = 'indexing'
    and a.rights in ('owned', 'licensed')
    and a.usable_for_conditioning
    and a.content_sha256 = i.content_sha256
    and a.conditioning_sha256 = i.conditioning_sha256
    and a.mime_type = i.mime_type
    and a.byte_size = i.byte_size
    and a.conditioning_storage_bucket = 'inspiration-conditioning'
    and a.conditioning_storage_path is not null;

  if v_valid_assets <> v_run.asset_count then
    update public.reference_index_runs
    set status = 'failed',
        lease_token = null,
        lease_expires_at = null,
        error_code = 'reference_assets_invalid',
        error_detail = 'one or more atomically claimed assets no longer match',
        completed_at = now(),
        updated_at = now()
    where id = v_run.id;
    update public.inspiration_assets
    set index_status = 'failed',
        index_error = 'reference_assets_invalid',
        reference_index_run_id = null,
        reference_index_claimed_at = null,
        reference_index_claim_expires_at = null
    where reference_index_run_id = v_run.id;
    return query select false, 'failed'::text, v_run.attempt_number,
      null::uuid, null::timestamptz;
    return;
  end if;

  v_token := extensions.gen_random_uuid();
  update public.reference_index_runs
  set status = 'processing',
      attempt_number = public.reference_index_runs.attempt_number + 1,
      lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      error_code = null,
      error_detail = null,
      updated_at = now()
  where id = v_run.id
  returning * into v_run;

  return query select true, v_run.status, v_run.attempt_number,
    v_run.lease_token, v_run.lease_expires_at;
end;
$$;

create or replace function public.begin_reference_index_provider_call(
  p_run_id uuid,
  p_requested_by uuid,
  p_attempt_number integer,
  p_lease_token uuid,
  p_call_id uuid,
  p_stage text,
  p_call_ordinal integer,
  p_model_ref text,
  p_request_hash text
)
returns table (
  invoke_allowed boolean,
  call_id uuid,
  call_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.reference_index_runs%rowtype;
  v_call public.reference_index_provider_calls%rowtype;
  v_valid_assets integer;
begin
  if coalesce(p_stage, '') not in
      ('vision', 'text_embedding', 'visual_embedding')
    or p_call_ordinal is null
    or p_call_ordinal not between 0 and 2
    or (p_stage in ('vision', 'text_embedding') and p_call_ordinal <> 0)
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
    or nullif(p_model_ref, '') is null
    or length(p_model_ref) > 200 then
    raise exception 'invalid_provider_call' using errcode = '22023';
  end if;

  select * into v_run
  from public.reference_index_runs r
  where r.id = p_run_id and r.requested_by = p_requested_by
  for update;
  if not found then
    raise exception 'reference_index_run_not_found' using errcode = 'P0002';
  end if;
  if v_run.status <> 'processing'
    or v_run.attempt_number <> p_attempt_number
    or v_run.lease_token <> p_lease_token
    or v_run.lease_expires_at <= now() then
    raise exception 'reference_index_lease_lost' using errcode = '40001';
  end if;
  if (p_stage = 'vision' and p_model_ref <>
      v_run.request_manifest ->> 'visionModel')
    or (p_stage in ('text_embedding', 'visual_embedding') and p_model_ref <>
      v_run.request_manifest ->> 'embeddingModel')
    or (p_stage = 'visual_embedding' and p_call_ordinal >=
      v_run.expected_visual_embedding_calls) then
    raise exception 'reference_provider_model_or_ordinal_mismatch'
      using errcode = '23514';
  end if;

  select * into v_call
  from public.reference_index_provider_calls c
  where c.run_id = p_run_id
    and c.stage = p_stage
    and c.call_ordinal = p_call_ordinal
  for update;
  if found then
    if v_call.model_ref <> p_model_ref
      or v_call.request_hash <> p_request_hash then
      raise exception 'reference_provider_call_conflict' using errcode = '23505';
    end if;
    return query select false, v_call.id, v_call.status;
    return;
  end if;

  -- Lock the exact claimed assets before checking rights and hashes. The call
  -- row is inserted in this same transaction, so revocation cannot race the
  -- durable permission to invoke provider HTTP.
  perform a.id
  from public.reference_index_run_items i
  join public.inspiration_assets a on a.id = i.asset_id
  where i.run_id = v_run.id
  order by i.ordinal
  for update of a;

  select count(*) into v_valid_assets
  from public.reference_index_run_items i
  join public.inspiration_assets a on a.id = i.asset_id
  join lateral (
    select value as item
    from jsonb_array_elements(v_run.request_manifest -> 'assets')
    where value ->> 'assetId' = i.asset_id::text
  ) m on true
  where i.run_id = v_run.id
    and a.reference_index_run_id = v_run.id
    and a.index_status = 'indexing'
    and a.rights in ('owned', 'licensed')
    and a.rights = m.item ->> 'rights'
    and a.usable_for_conditioning
    and m.item -> 'usableForConditioning' = 'true'::jsonb
    and a.profile_id::text is not distinct from (m.item ->> 'ownerProfileId')
    and a.source = m.item ->> 'source'
    and a.style_pack_id is not distinct from (m.item ->> 'stylePackId')
    and a.storage_path = m.item ->> 'storagePath'
    and a.content_sha256 = i.content_sha256
    and a.content_sha256 = m.item ->> 'contentSha256'
    and a.conditioning_sha256 = i.conditioning_sha256
    and a.conditioning_sha256 = m.item ->> 'conditioningSha256'
    and a.conditioning_storage_bucket = 'inspiration-conditioning'
    and a.conditioning_storage_bucket =
      m.item ->> 'conditioningStorageBucket'
    and a.conditioning_storage_path =
      m.item ->> 'conditioningStoragePath'
    and a.mime_type = i.mime_type
    and a.mime_type = m.item ->> 'mimeType'
    and a.byte_size = i.byte_size
    and a.byte_size = (m.item ->> 'byteSize')::bigint;

  if v_valid_assets <> v_run.asset_count then
    raise exception 'reference_rights_or_hash_revalidation_failed'
      using errcode = '23514';
  end if;

  insert into public.reference_index_provider_calls (
    id,
    run_id,
    requested_by,
    attempt_number,
    stage,
    call_ordinal,
    model_ref,
    request_hash
  ) values (
    p_call_id,
    p_run_id,
    p_requested_by,
    p_attempt_number,
    p_stage,
    p_call_ordinal,
    p_model_ref,
    p_request_hash
  )
  returning * into v_call;

  update public.reference_index_runs
  set lease_expires_at = now() + interval '10 minutes', updated_at = now()
  where id = p_run_id;

  return query select true, v_call.id, v_call.status;
end;
$$;

create or replace function public.fail_reference_index_run(
  p_run_id uuid,
  p_requested_by uuid,
  p_attempt_number integer,
  p_lease_token uuid,
  p_error_code text,
  p_error_detail text
)
returns table (
  failed boolean,
  replayed boolean,
  run_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.reference_index_runs%rowtype;
  v_error_code text := left(coalesce(p_error_code, 'reference_index_failed'), 100);
  v_error_detail text := left(coalesce(p_error_detail, ''), 1000);
begin
  if length(v_error_code) < 1 then
    raise exception 'invalid_reference_failure' using errcode = '22023';
  end if;

  select * into v_run
  from public.reference_index_runs r
  where r.id = p_run_id and r.requested_by = p_requested_by
  for update;
  if not found then
    raise exception 'reference_index_run_not_found' using errcode = 'P0002';
  end if;

  -- Terminal replay is checked before lease state, making a lost successful
  -- response safe to submit again for the same attempt and failure payload.
  if v_run.status = 'failed' then
    if v_run.attempt_number = p_attempt_number
      and v_run.error_code = v_error_code
      and coalesce(v_run.error_detail, '') = v_error_detail then
      return query select true, true, v_run.status;
      return;
    end if;
    raise exception 'reference_failure_conflict' using errcode = '23505';
  elsif v_run.status in ('completed', 'indeterminate') then
    raise exception 'reference_run_already_terminal' using errcode = '55000';
  end if;

  if v_run.status <> 'processing'
    or v_run.attempt_number <> p_attempt_number
    or v_run.lease_token <> p_lease_token
    or v_run.lease_expires_at <= now() then
    raise exception 'reference_index_lease_lost' using errcode = '40001';
  end if;
  if exists (
    select 1
    from public.reference_index_provider_calls c
    where c.run_id = v_run.id
  ) then
    raise exception 'pre_provider_failure_has_provider_call'
      using errcode = '23514';
  end if;

  update public.reference_index_runs
  set status = 'failed',
      lease_token = null,
      lease_expires_at = null,
      error_code = v_error_code,
      error_detail = v_error_detail,
      completed_at = now(),
      updated_at = now()
  where id = v_run.id;

  update public.inspiration_assets
  set index_status = 'failed',
      index_error = v_error_code,
      reference_index_run_id = null,
      reference_index_claimed_at = null,
      reference_index_claim_expires_at = null
  where reference_index_run_id = v_run.id;

  return query select true, false, 'failed'::text;
end;
$$;

create or replace function public.record_reference_index_provider_failure(
  p_run_id uuid,
  p_requested_by uuid,
  p_attempt_number integer,
  p_lease_token uuid,
  p_call_id uuid,
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
  v_run public.reference_index_runs%rowtype;
  v_call public.reference_index_provider_calls%rowtype;
  v_billing text;
  v_error_code text := left(coalesce(p_error_code, 'provider_failure'), 100);
  v_error_detail text := left(coalesce(p_error_detail, ''), 1000);
  v_provider_request_id text := nullif(p_provider_request_id, '');
begin
  if p_outcome not in ('rejected', 'failed', 'indeterminate') then
    raise exception 'invalid_provider_failure_outcome' using errcode = '22023';
  end if;

  select * into v_run
  from public.reference_index_runs r
  where r.id = p_run_id and r.requested_by = p_requested_by
  for update;
  if not found then
    raise exception 'reference_index_run_not_found' using errcode = 'P0002';
  end if;
  select * into v_call
  from public.reference_index_provider_calls c
  where c.id = p_call_id
    and c.run_id = p_run_id
    and c.requested_by = p_requested_by
  for update;
  if not found then
    raise exception 'reference_provider_call_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent terminal replay must precede the active-run/lease predicate.
  if v_call.status <> 'prepared' then
    if v_call.status = p_outcome
      and v_call.attempt_number = p_attempt_number
      and coalesce(v_call.error_code, '') = v_error_code
      and coalesce(v_call.error_detail, '') = v_error_detail
      and v_call.provider_request_id is not distinct from v_provider_request_id then
      return v_call.status;
    end if;
    raise exception 'reference_provider_failure_conflict' using errcode = '23505';
  end if;

  if v_run.status <> 'processing'
    or v_run.attempt_number <> p_attempt_number
    or v_run.lease_token <> p_lease_token then
    raise exception 'reference_index_lease_lost' using errcode = '40001';
  end if;

  v_billing := case when p_outcome = 'rejected'
    then 'not_billable' else 'unknown' end;

  update public.reference_index_provider_calls
  set status = p_outcome,
      provider_request_id = v_provider_request_id,
      billing_state = v_billing,
      error_code = v_error_code,
      error_detail = v_error_detail,
      provider_completed_at = now(),
      updated_at = now()
  where id = p_call_id;

  update public.reference_index_runs
  set status = case when p_outcome = 'indeterminate'
      then 'indeterminate' else 'failed' end,
      lease_token = null,
      lease_expires_at = null,
      error_code = v_error_code,
      error_detail = v_error_detail,
      completed_at = now(),
      updated_at = now()
  where id = p_run_id;

  update public.inspiration_assets
  set index_status = 'failed',
      index_error = v_error_code,
      reference_index_run_id = null,
      reference_index_claimed_at = null,
      reference_index_claim_expires_at = null
  where reference_index_run_id = p_run_id;

  return p_outcome;
end;
$$;

create or replace function public.reap_stale_reference_index_work(
  p_limit integer default 25,
  p_reservation_grace_seconds integer default 900
)
returns table (
  work_kind text,
  work_id uuid,
  previous_status text,
  resulting_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.inspiration_assets%rowtype;
  v_run public.reference_index_runs%rowtype;
  v_processed integer := 0;
  v_remaining integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100
    or p_reservation_grace_seconds is null
    or p_reservation_grace_seconds < 120
    or p_reservation_grace_seconds > 3600 then
    raise exception 'invalid_reference_reaper_policy' using errcode = '22023';
  end if;

  for v_asset in
    select a.*
    from public.inspiration_assets a
    where a.index_status = 'indexing'
      and a.reference_index_run_id is null
      and a.reference_index_claim_expires_at <= now()
    order by a.reference_index_claim_expires_at, a.id
    for update skip locked
    limit p_limit
  loop
    update public.inspiration_assets
    set index_status = 'failed',
        index_error = 'reference_provisional_claim_expired',
        reference_index_run_id = null,
        reference_index_claimed_at = null,
        reference_index_claim_expires_at = null
    where id = v_asset.id;
    work_kind := 'asset_claim';
    work_id := v_asset.id;
    previous_status := 'indexing';
    resulting_status := 'failed';
    v_processed := v_processed + 1;
    return next;
  end loop;

  v_remaining := p_limit - v_processed;
  if v_remaining <= 0 then
    return;
  end if;

  for v_run in
    select r.*
    from public.reference_index_runs r
    where (
        r.status = 'reserved'
        and r.updated_at <= now() -
          make_interval(secs => p_reservation_grace_seconds)
      )
      or (
        r.status = 'processing'
        and r.lease_expires_at <= now()
      )
    order by coalesce(r.lease_expires_at, r.updated_at), r.id
    for update skip locked
    limit v_remaining
  loop
    work_kind := 'run';
    work_id := v_run.id;
    previous_status := v_run.status;

    if v_run.status = 'processing' and exists (
      select 1
      from public.reference_index_provider_calls c
      where c.run_id = v_run.id and c.status = 'prepared'
    ) then
      update public.reference_index_provider_calls
      set status = 'indeterminate',
          billing_state = 'unknown',
          error_code = 'provider_outcome_unknown',
          error_detail = 'lease expired after provider call preparation',
          provider_completed_at = now(),
          updated_at = now()
      where run_id = v_run.id and status = 'prepared';
      update public.reference_index_runs
      set status = 'indeterminate',
          lease_token = null,
          lease_expires_at = null,
          error_code = 'provider_outcome_unknown',
          error_detail = 'lease expired after a provider call was prepared',
          completed_at = now(),
          updated_at = now()
      where id = v_run.id;
      update public.inspiration_assets
      set index_status = 'failed',
          index_error = 'provider_outcome_unknown',
          reference_index_run_id = null,
          reference_index_claimed_at = null,
          reference_index_claim_expires_at = null
      where reference_index_run_id = v_run.id;
      resulting_status := 'indeterminate';
    elsif v_run.status = 'processing' then
      update public.reference_index_runs
      set status = 'reserved',
          lease_token = null,
          lease_expires_at = null,
          error_code = 'lease_expired_requeued',
          error_detail = 'expired worker lease was requeued without provider ambiguity',
          updated_at = now()
      where id = v_run.id;
      resulting_status := 'reserved';
    else
      update public.reference_index_runs
      set status = 'failed',
          lease_token = null,
          lease_expires_at = null,
          error_code = 'reservation_expired',
          error_detail = 'reserved reference-index run exceeded its claim grace period',
          completed_at = now(),
          updated_at = now()
      where id = v_run.id;
      update public.inspiration_assets
      set index_status = 'failed',
          index_error = 'reservation_expired',
          reference_index_run_id = null,
          reference_index_claimed_at = null,
          reference_index_claim_expires_at = null
      where reference_index_run_id = v_run.id;
      resulting_status := 'failed';
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.reserve_reference_index_run(uuid, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.claim_reference_index_run(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.begin_reference_index_provider_call(
  uuid, uuid, integer, uuid, uuid, text, integer, text, text
) from public, anon, authenticated;
revoke all on function public.fail_reference_index_run(
  uuid, uuid, integer, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.record_reference_index_provider_failure(
  uuid, uuid, integer, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.reap_stale_reference_index_work(integer, integer)
  from public, anon, authenticated;

grant execute on function public.reserve_reference_index_run(uuid, text, jsonb, text)
  to service_role;
grant execute on function public.claim_reference_index_run(uuid, uuid, integer)
  to service_role;
grant execute on function public.begin_reference_index_provider_call(
  uuid, uuid, integer, uuid, uuid, text, integer, text, text
) to service_role;
grant execute on function public.fail_reference_index_run(
  uuid, uuid, integer, uuid, text, text
) to service_role;
grant execute on function public.record_reference_index_provider_failure(
  uuid, uuid, integer, uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.reap_stale_reference_index_work(integer, integer)
  to service_role;

comment on column public.inspiration_assets.reference_index_run_id is
  'Durable run binding for an atomically claimed reference; retained on ready rows as provenance.';
comment on function public.fail_reference_index_run(
  uuid, uuid, integer, uuid, text, text
) is 'Idempotent service-only pre-provider terminal failure and asset-claim release.';
comment on function public.reap_stale_reference_index_work(integer, integer) is
  'Claims expired provisional assets and run leases with SKIP LOCKED; schedule through a trusted service worker.';

commit;
