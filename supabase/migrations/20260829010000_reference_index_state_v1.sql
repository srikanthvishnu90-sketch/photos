-- Durable, at-most-once reference indexing state.
--
-- A provider call is prepared in the database before the HTTP request. Its
-- normalized response and cost are then staged atomically. If recording the
-- response has an unknown outcome, the worker reads this state and retries the
-- database write only; it never sends the provider request again.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.reference_index_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  request_manifest jsonb not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  indexing_version text not null,
  asset_count integer not null check (asset_count between 1 and 16),
  expected_vision_calls integer not null default 1
    check (expected_vision_calls = 1),
  expected_text_embedding_calls integer not null default 1
    check (expected_text_embedding_calls = 1),
  expected_visual_embedding_calls integer not null
    check (expected_visual_embedding_calls between 1 and 3),
  status text not null default 'reserved' check (
    status in (
      'reserved',
      'processing',
      'completed',
      'failed',
      'indeterminate'
    )
  ),
  attempt_number integer not null default 0 check (attempt_number >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (requested_by, idempotency_key),
  unique (id, requested_by),
  check (
    (status = 'reserved' and lease_token is null and lease_expires_at is null)
    or
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or
    (status in ('completed', 'failed', 'indeterminate') and completed_at is not null)
  )
);

create table if not exists public.reference_index_run_items (
  run_id uuid not null references public.reference_index_runs(id)
    on delete cascade,
  asset_id uuid not null references public.inspiration_assets(id)
    on delete cascade,
  ordinal integer not null check (ordinal between 0 and 15),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  conditioning_sha256 text not null
    check (conditioning_sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  byte_size bigint not null check (byte_size between 1 and 5242880),
  created_at timestamptz not null default now(),
  primary key (run_id, asset_id),
  unique (run_id, ordinal),
  unique (run_id, conditioning_sha256)
);

create table if not exists public.reference_index_provider_calls (
  id uuid primary key,
  run_id uuid not null references public.reference_index_runs(id)
    on delete cascade,
  requested_by uuid not null,
  attempt_number integer not null check (attempt_number >= 1),
  stage text not null check (
    stage in ('vision', 'text_embedding', 'visual_embedding')
  ),
  call_ordinal integer not null check (call_ordinal between 0 and 2),
  provider text not null default 'google',
  model_ref text not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'prepared' check (
    status in ('prepared', 'succeeded', 'rejected', 'failed', 'indeterminate')
  ),
  provider_request_id text,
  response_payload jsonb,
  response_hash text check (
    response_hash is null or response_hash ~ '^[a-f0-9]{64}$'
  ),
  input_units bigint check (input_units is null or input_units >= 0),
  output_units bigint check (output_units is null or output_units >= 0),
  cost_micros bigint check (cost_micros is null or cost_micros >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  billing_state text not null default 'pending' check (
    billing_state in ('pending', 'reported', 'not_billable', 'unknown')
  ),
  provider_meta jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  started_at timestamptz not null default now(),
  provider_completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (run_id, stage, call_ordinal),
  foreign key (run_id, requested_by)
    references public.reference_index_runs(id, requested_by)
    on delete cascade,
  check (
    (status = 'prepared' and provider_completed_at is null)
    or
    (status <> 'prepared' and provider_completed_at is not null)
  ),
  check (
    (status = 'succeeded' and response_payload is not null and response_hash is not null)
    or
    (status <> 'succeeded')
  )
);

create index if not exists reference_index_runs_recovery_idx
  on public.reference_index_runs (lease_expires_at, created_at)
  where status = 'processing';

create index if not exists reference_index_provider_cost_idx
  on public.reference_index_provider_calls (provider_completed_at, id)
  where status = 'succeeded';

create or replace function public.prevent_terminal_reference_call_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'prepared' and new is distinct from old then
    raise exception 'terminal_reference_provider_call_is_immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists reference_provider_call_terminal_immutable
  on public.reference_index_provider_calls;
create trigger reference_provider_call_terminal_immutable
before update on public.reference_index_provider_calls
for each row execute function public.prevent_terminal_reference_call_mutation();

alter table public.reference_index_runs enable row level security;
alter table public.reference_index_run_items enable row level security;
alter table public.reference_index_provider_calls enable row level security;

revoke all on public.reference_index_runs from public, anon, authenticated;
revoke all on public.reference_index_run_items from public, anon, authenticated;
revoke all on public.reference_index_provider_calls from public, anon, authenticated;

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
  v_hash text;
  v_asset_count integer;
  v_item jsonb;
  v_ordinal integer := 0;
begin
  if p_requested_by is null then
    raise exception 'requested_by_required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or length(p_idempotency_key) < 8
    or length(p_idempotency_key) > 200 then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_indexing_version is null or length(p_indexing_version) > 100 then
    raise exception 'invalid_indexing_version' using errcode = '22023';
  end if;
  if jsonb_typeof(p_request_manifest) <> 'object'
    or jsonb_typeof(p_request_manifest -> 'assets') <> 'array' then
    raise exception 'invalid_reference_manifest' using errcode = '22023';
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

  for v_item in
    select value from jsonb_array_elements(p_request_manifest -> 'assets')
  loop
    if jsonb_typeof(v_item) <> 'object'
      or coalesce(v_item ->> 'assetId', '') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(v_item ->> 'contentSha256', '') !~ '^[a-f0-9]{64}$'
      or coalesce(v_item ->> 'conditioningSha256', '') !~ '^[a-f0-9]{64}$'
      or coalesce(v_item ->> 'mimeType', '') not in ('image/jpeg', 'image/png')
      or coalesce((v_item ->> 'byteSize')::bigint, 0) not between 1 and 5242880 then
      raise exception 'invalid_reference_manifest_item' using errcode = '22023';
    end if;

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
      (v_item ->> 'assetId')::uuid,
      v_ordinal,
      v_item ->> 'contentSha256',
      v_item ->> 'conditioningSha256',
      v_item ->> 'mimeType',
      (v_item ->> 'byteSize')::bigint
    );
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
begin
  if p_lease_seconds < 120 or p_lease_seconds > 900 then
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

  if v_run.status = 'processing' then
    if exists (
      select 1 from public.reference_index_provider_calls c
      where c.run_id = v_run.id and c.status = 'prepared'
    ) then
      update public.reference_index_runs
      set status = 'indeterminate',
          error_code = 'provider_outcome_unknown',
          error_detail = 'lease expired after a provider call was prepared',
          completed_at = now(),
          updated_at = now()
      where id = v_run.id;
      return query select false, 'indeterminate'::text,
        v_run.attempt_number, v_run.lease_token, v_run.lease_expires_at;
      return;
    end if;
  end if;

  v_token := gen_random_uuid();
  update public.reference_index_runs
  set status = 'processing',
      attempt_number = attempt_number + 1,
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
begin
  if p_stage not in ('vision', 'text_embedding', 'visual_embedding')
    or p_call_ordinal not between 0 and 2
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_model_ref is null
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

  select * into v_call
  from public.reference_index_provider_calls c
  where c.run_id = p_run_id
    and c.stage = p_stage
    and c.call_ordinal = p_call_ordinal
  for update;
  if found then
    return query select false, v_call.id, v_call.status;
    return;
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

create or replace function public.record_reference_index_provider_result(
  p_run_id uuid,
  p_requested_by uuid,
  p_attempt_number integer,
  p_lease_token uuid,
  p_call_id uuid,
  p_response_payload jsonb,
  p_provider_request_id text,
  p_input_units bigint,
  p_output_units bigint,
  p_cost_micros bigint,
  p_provider_meta jsonb default '{}'::jsonb
)
returns table (
  staged boolean,
  replayed boolean,
  response_hash text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.reference_index_runs%rowtype;
  v_call public.reference_index_provider_calls%rowtype;
  v_response_hash text;
begin
  if jsonb_typeof(p_response_payload) not in ('object', 'array')
    or octet_length(p_response_payload::text) > 1048576
    or coalesce(p_input_units, 0) < 0
    or coalesce(p_output_units, 0) < 0
    or coalesce(p_cost_micros, 0) < 0 then
    raise exception 'invalid_provider_result' using errcode = '22023';
  end if;

  v_response_hash := encode(
    extensions.digest(
      convert_to(p_response_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

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

  if v_call.status = 'succeeded' then
    if v_call.response_hash <> v_response_hash then
      raise exception 'provider_result_conflict' using errcode = '23505';
    end if;
    return query select true, true, v_call.response_hash;
    return;
  end if;

  if v_call.status <> 'prepared'
    or v_run.status <> 'processing'
    or v_run.attempt_number <> p_attempt_number
    or v_run.lease_token <> p_lease_token then
    raise exception 'provider_result_not_recordable' using errcode = '40001';
  end if;

  update public.reference_index_provider_calls
  set status = 'succeeded',
      provider_request_id = nullif(p_provider_request_id, ''),
      response_payload = p_response_payload,
      response_hash = v_response_hash,
      input_units = coalesce(p_input_units, 0),
      output_units = coalesce(p_output_units, 0),
      cost_micros = coalesce(p_cost_micros, 0),
      billing_state = 'reported',
      provider_meta = coalesce(p_provider_meta, '{}'::jsonb),
      provider_completed_at = now(),
      updated_at = now()
  where id = p_call_id;

  update public.reference_index_runs
  set lease_expires_at = now() + interval '10 minutes', updated_at = now()
  where id = p_run_id;

  return query select true, false, v_response_hash;
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
  v_status text;
  v_billing text;
begin
  if p_outcome not in ('rejected', 'failed', 'indeterminate') then
    raise exception 'invalid_provider_failure_outcome' using errcode = '22023';
  end if;

  perform 1
  from public.reference_index_runs r
  where r.id = p_run_id
    and r.requested_by = p_requested_by
    and r.status = 'processing'
    and r.attempt_number = p_attempt_number
    and r.lease_token = p_lease_token
  for update;
  if not found then
    raise exception 'reference_index_lease_lost' using errcode = '40001';
  end if;

  select status into v_status
  from public.reference_index_provider_calls c
  where c.id = p_call_id
    and c.run_id = p_run_id
    and c.requested_by = p_requested_by
  for update;
  if not found then
    raise exception 'reference_provider_call_not_found' using errcode = 'P0002';
  end if;
  if v_status <> 'prepared' then
    return v_status;
  end if;

  v_billing := case
    when p_outcome = 'rejected' then 'not_billable'
    else 'unknown'
  end;

  update public.reference_index_provider_calls
  set status = p_outcome,
      provider_request_id = nullif(p_provider_request_id, ''),
      billing_state = v_billing,
      error_code = left(coalesce(p_error_code, 'provider_failure'), 100),
      error_detail = left(coalesce(p_error_detail, ''), 1000),
      provider_completed_at = now(),
      updated_at = now()
  where id = p_call_id;

  update public.reference_index_runs
  set status = case when p_outcome = 'indeterminate'
      then 'indeterminate' else 'failed' end,
      error_code = left(coalesce(p_error_code, 'provider_failure'), 100),
      error_detail = left(coalesce(p_error_detail, ''), 1000),
      completed_at = now(),
      updated_at = now()
  where id = p_run_id;

  return p_outcome;
end;
$$;

create or replace function public.complete_reference_index_run(
  p_run_id uuid,
  p_requested_by uuid,
  p_attempt_number integer,
  p_lease_token uuid
)
returns table (
  completed boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.reference_index_runs%rowtype;
  v_ready_count integer;
  v_vision_count integer;
  v_text_count integer;
  v_visual_count integer;
begin
  select * into v_run
  from public.reference_index_runs r
  where r.id = p_run_id and r.requested_by = p_requested_by
  for update;
  if not found then
    raise exception 'reference_index_run_not_found' using errcode = 'P0002';
  end if;
  if v_run.status = 'completed' then
    return query select true, true;
    return;
  end if;
  if v_run.status <> 'processing'
    or v_run.attempt_number <> p_attempt_number
    or v_run.lease_token <> p_lease_token then
    raise exception 'reference_index_lease_lost' using errcode = '40001';
  end if;

  select count(*) into v_ready_count
  from public.reference_index_run_items i
  join public.inspiration_assets a on a.id = i.asset_id
  where i.run_id = p_run_id
    and a.index_status = 'ready'
    and a.embedding is not null
    and a.visual_embedding is not null
    and a.content_sha256 = i.content_sha256
    and a.conditioning_sha256 = i.conditioning_sha256
    and a.embedding_model = v_run.request_manifest ->> 'embeddingModel'
    and a.indexing_version = v_run.indexing_version;

  select
    count(*) filter (where stage = 'vision' and status = 'succeeded'),
    count(*) filter (where stage = 'text_embedding' and status = 'succeeded'),
    count(*) filter (where stage = 'visual_embedding' and status = 'succeeded')
  into v_vision_count, v_text_count, v_visual_count
  from public.reference_index_provider_calls
  where run_id = p_run_id;

  if v_ready_count <> v_run.asset_count
    or v_vision_count <> v_run.expected_vision_calls
    or v_text_count <> v_run.expected_text_embedding_calls
    or v_visual_count <> v_run.expected_visual_embedding_calls then
    raise exception 'reference_index_incomplete' using errcode = '23514';
  end if;

  update public.reference_index_runs
  set status = 'completed',
      completed_at = now(),
      updated_at = now()
  where id = p_run_id;

  return query select true, false;
end;
$$;

create or replace function public.get_reference_index_run_state(
  p_run_id uuid,
  p_requested_by uuid
)
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'requestHash', r.request_hash,
    'indexingVersion', r.indexing_version,
    'attemptNumber', r.attempt_number,
    'leaseToken', r.lease_token,
    'leaseExpiresAt', r.lease_expires_at,
    'errorCode', r.error_code,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'assetId', i.asset_id,
        'ordinal', i.ordinal,
        'contentSha256', i.content_sha256,
        'conditioningSha256', i.conditioning_sha256,
        'mimeType', i.mime_type,
        'byteSize', i.byte_size
      ) order by i.ordinal)
      from public.reference_index_run_items i
      where i.run_id = r.id
    ), '[]'::jsonb),
    'calls', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'stage', c.stage,
        'callOrdinal', c.call_ordinal,
        'status', c.status,
        'modelRef', c.model_ref,
        'requestHash', c.request_hash,
        'providerRequestId', c.provider_request_id,
        'responsePayload', c.response_payload,
        'responseHash', c.response_hash,
        'inputUnits', c.input_units,
        'outputUnits', c.output_units,
        'costMicros', c.cost_micros,
        'billingState', c.billing_state,
        'errorCode', c.error_code
      ) order by
        case c.stage
          when 'vision' then 0
          when 'text_embedding' then 1
          else 2
        end,
        c.call_ordinal)
      from public.reference_index_provider_calls c
      where c.run_id = r.id
    ), '[]'::jsonb)
  )
  from public.reference_index_runs r
  where r.id = p_run_id and r.requested_by = p_requested_by;
$$;

revoke all on function public.reserve_reference_index_run(uuid, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.claim_reference_index_run(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.begin_reference_index_provider_call(
  uuid, uuid, integer, uuid, uuid, text, integer, text, text
) from public, anon, authenticated;
revoke all on function public.record_reference_index_provider_result(
  uuid, uuid, integer, uuid, uuid, jsonb, text, bigint, bigint, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.record_reference_index_provider_failure(
  uuid, uuid, integer, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.complete_reference_index_run(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.get_reference_index_run_state(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.reserve_reference_index_run(uuid, text, jsonb, text)
  to service_role;
grant execute on function public.claim_reference_index_run(uuid, uuid, integer)
  to service_role;
grant execute on function public.begin_reference_index_provider_call(
  uuid, uuid, integer, uuid, uuid, text, integer, text, text
) to service_role;
grant execute on function public.record_reference_index_provider_result(
  uuid, uuid, integer, uuid, uuid, jsonb, text, bigint, bigint, bigint, jsonb
) to service_role;
grant execute on function public.record_reference_index_provider_failure(
  uuid, uuid, integer, uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.complete_reference_index_run(uuid, uuid, integer, uuid)
  to service_role;
grant execute on function public.get_reference_index_run_state(uuid, uuid)
  to service_role;

comment on table public.reference_index_provider_calls is
  'One immutable terminal record per actual or potentially initiated reference-index provider HTTP call.';
