-- Durable, edit-specific quota/idempotency/provider/output lifecycle.
-- Full image, mask, and instruction bytes remain in the explicitly requested
-- Edge call; PostgreSQL stores hashes, bounded metadata, and settlement state.

begin;

create or replace function public.edit_json_sha256(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select encode(
    extensions.digest(convert_to(p_value::text, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

create or replace function public.edit_output_storage_path(
  p_profile_id uuid,
  p_job_id uuid,
  p_mime_type text
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select p_profile_id::text || '/edit/' || p_job_id::text || '/output.' ||
    case p_mime_type
      when 'image/jpeg' then 'jpg'
      when 'image/png' then 'png'
      when 'image/webp' then 'webp'
      else 'invalid'
    end
$$;

create or replace function public.edit_output_storage_paths(
  p_profile_id uuid,
  p_job_id uuid
)
returns text[]
language sql
immutable
strict
set search_path = ''
as $$
  select array[
    public.edit_output_storage_path(p_profile_id, p_job_id, 'image/jpeg'),
    public.edit_output_storage_path(p_profile_id, p_job_id, 'image/png'),
    public.edit_output_storage_path(p_profile_id, p_job_id, 'image/webp')
  ]::text[]
$$;

create or replace function public.edit_request_manifest_valid(p_manifest jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_has_mask boolean;
begin
  if p_manifest is null
    or jsonb_typeof(p_manifest) is distinct from 'object'
    or octet_length(p_manifest::text) > 32768
    or (select count(*) from jsonb_object_keys(p_manifest)) <> 11
    or not (
      p_manifest ? 'schema'
      and p_manifest ? 'provider'
      and p_manifest ? 'modelRef'
      and p_manifest ? 'promptVersion'
      and p_manifest ? 'kind'
      and p_manifest ? 'photoId'
      and p_manifest ? 'style'
      and p_manifest ? 'inputSha256'
      and p_manifest ? 'instructionSha256'
      and p_manifest ? 'hasMask'
      and p_manifest ? 'maskSha256'
    )
    or p_manifest ->> 'schema' is distinct from 'edit-request-v1'
    or char_length(coalesce(p_manifest ->> 'provider', '')) not between 1 and 40
    or char_length(coalesce(p_manifest ->> 'modelRef', '')) not between 1 and 120
    or char_length(coalesce(p_manifest ->> 'promptVersion', '')) not between 1 and 80
    or char_length(coalesce(p_manifest ->> 'kind', '')) not between 1 and 40
    or (
      p_manifest -> 'photoId' <> 'null'::jsonb
      and (
        jsonb_typeof(p_manifest -> 'photoId') is distinct from 'string'
        or char_length(p_manifest ->> 'photoId') not between 1 and 200
      )
    )
    or (
      p_manifest -> 'style' <> 'null'::jsonb
      and (
        jsonb_typeof(p_manifest -> 'style') is distinct from 'string'
        or char_length(p_manifest ->> 'style') not between 1 and 80
      )
    )
    or coalesce(p_manifest ->> 'inputSha256', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_manifest ->> 'instructionSha256', '') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_manifest -> 'hasMask') is distinct from 'boolean' then
    return false;
  end if;
  v_has_mask := (p_manifest ->> 'hasMask')::boolean;
  if v_has_mask then
    return coalesce(p_manifest ->> 'maskSha256', '') ~ '^[a-f0-9]{64}$';
  end if;
  return p_manifest -> 'maskSha256' = 'null'::jsonb;
exception when others then
  return false;
end;
$$;

create table public.edit_generation_policy (
  policy_key text primary key check (policy_key = 'default'),
  free_monthly_limit integer not null check (
    free_monthly_limit between 0 and 10000
  ),
  reservation_ttl_seconds integer not null check (
    reservation_ttl_seconds between 60 and 3600
  ),
  lease_seconds integer not null check (lease_seconds between 30 and 1800),
  retry_grace_seconds integer not null check (
    retry_grace_seconds between 60 and 3600
  ),
  indeterminate_release_seconds integer not null check (
    indeterminate_release_seconds between 300 and 86400
  ),
  updated_at timestamptz not null default now()
);

insert into public.edit_generation_policy (
  policy_key,
  free_monthly_limit,
  reservation_ttl_seconds,
  lease_seconds,
  retry_grace_seconds,
  indeterminate_release_seconds
) values ('default', 10, 900, 600, 300, 3600);

create table public.edit_generation_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  idempotency_key text not null check (
    char_length(idempotency_key) between 8 and 128
  ),
  request_manifest jsonb not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'reserved' check (status in (
    'reserved', 'processing', 'provider_prepared', 'result_captured',
    'delivered', 'failed', 'indeterminate'
  )),
  provider text not null check (char_length(provider) between 1 and 40),
  model_ref text not null check (char_length(model_ref) between 1 and 120),
  prompt_version text not null check (
    char_length(prompt_version) between 1 and 80
  ),
  attempt_number integer not null default 0 check (attempt_number >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  reservation_expires_at timestamptz not null,
  output_storage_bucket text,
  output_storage_path text,
  output_mime_type text,
  output_byte_size bigint,
  output_content_sha256 text,
  output_width integer,
  output_height integer,
  result_hash text,
  provider_response_id text,
  taste_event_id uuid unique,
  error_code text,
  error_detail text,
  started_at timestamptz,
  provider_completed_at timestamptz,
  result_captured_at timestamptz,
  indeterminate_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, idempotency_key),
  unique (id, profile_id),
  foreign key (taste_event_id) references public.taste_events(id)
    on delete no action deferrable initially deferred,
  check (public.edit_request_manifest_valid(request_manifest)),
  check (request_hash = public.edit_json_sha256(request_manifest)),
  check (request_manifest ->> 'provider' = provider),
  check (request_manifest ->> 'modelRef' = model_ref),
  check (request_manifest ->> 'promptVersion' = prompt_version),
  check (
    (status = 'reserved' and lease_token is null and lease_expires_at is null)
    or
    (status in ('processing', 'provider_prepared')
      and lease_token is not null and lease_expires_at is not null)
    or
    (status in ('result_captured', 'delivered', 'failed', 'indeterminate')
      and lease_token is null and lease_expires_at is null)
  ),
  check (
    (
      status in ('result_captured', 'delivered')
      and output_storage_bucket = 'edits'
      and output_storage_path = public.edit_output_storage_path(
        profile_id, id, output_mime_type
      )
      and output_mime_type in ('image/jpeg', 'image/png', 'image/webp')
      and output_byte_size between 1 and 26214400
      and output_content_sha256 ~ '^[a-f0-9]{64}$'
      and result_hash ~ '^[a-f0-9]{64}$'
      and result_captured_at is not null
      and (
        (output_width is null and output_height is null)
        or
        (output_width between 1 and 20000
          and output_height between 1 and 20000)
      )
    )
    or
    (
      status not in ('result_captured', 'delivered')
      and output_storage_bucket is null
      and output_storage_path is null
      and output_mime_type is null
      and output_byte_size is null
      and output_content_sha256 is null
      and output_width is null
      and output_height is null
      and result_hash is null
      and result_captured_at is null
    )
  ),
  check (
    (status = 'delivered' and delivered_at is not null
      and completed_at is not null and taste_event_id is not null)
    or (status <> 'delivered' and delivered_at is null)
  ),
  check (
    (status = 'failed' and completed_at is not null and error_code is not null)
    or status <> 'failed'
  ),
  check (
    (status = 'indeterminate' and indeterminate_at is not null)
    or (status <> 'indeterminate' and indeterminate_at is null)
  )
);

create index edit_generation_jobs_owner_created_idx
  on public.edit_generation_jobs(profile_id, created_at desc);
create index edit_generation_jobs_reaper_idx
  on public.edit_generation_jobs(status, reservation_expires_at, lease_expires_at)
  where status in ('reserved', 'processing', 'provider_prepared');

create table public.edit_quota_reservations (
  job_id uuid primary key,
  profile_id uuid not null,
  period_start date not null,
  units integer not null default 1 check (units = 1),
  plan_snapshot text not null check (plan_snapshot in ('free', 'plus')),
  free_limit_snapshot integer not null check (
    free_limit_snapshot between 0 and 10000
  ),
  state text not null default 'held' check (
    state in ('held', 'charged', 'released')
  ),
  charged_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (job_id, profile_id)
    references public.edit_generation_jobs(id, profile_id) on delete cascade,
  check (
    (state = 'held' and charged_at is null and released_at is null)
    or (state = 'charged' and charged_at is not null and released_at is null)
    or (state = 'released' and charged_at is null and released_at is not null)
  )
);

create index edit_quota_reservations_cap_idx
  on public.edit_quota_reservations(profile_id, period_start, state);

create table public.edit_provider_calls (
  id uuid primary key,
  job_id uuid not null unique,
  profile_id uuid not null,
  attempt_number integer not null check (attempt_number >= 1),
  provider text not null check (char_length(provider) between 1 and 40),
  model_ref text not null check (char_length(model_ref) between 1 and 120),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'prepared' check (status in (
    'prepared', 'succeeded', 'rejected', 'failed', 'indeterminate'
  )),
  result_manifest jsonb,
  result_hash text check (result_hash is null or result_hash ~ '^[a-f0-9]{64}$'),
  provider_request_id text,
  input_units bigint,
  output_units bigint,
  cost_micros bigint,
  currency text not null default 'USD' check (currency = 'USD'),
  billing_state text not null default 'pending' check (
    billing_state in ('pending', 'reported', 'not_billable', 'unknown')
  ),
  provider_meta jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  provider_started_at timestamptz not null default now(),
  provider_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (job_id, profile_id)
    references public.edit_generation_jobs(id, profile_id) on delete cascade,
  check (input_units is null or input_units >= 0),
  check (output_units is null or output_units >= 0),
  check (cost_micros is null or cost_micros >= 0),
  check (jsonb_typeof(provider_meta) = 'object'),
  check (
    (status = 'prepared' and result_manifest is null and result_hash is null
      and provider_completed_at is null and billing_state = 'pending')
    or
    (status = 'succeeded' and result_manifest is not null
      and result_hash is not null and provider_completed_at is not null
      and billing_state in ('reported', 'unknown'))
    or
    (status in ('rejected', 'failed', 'indeterminate')
      and result_manifest is null and result_hash is null
      and provider_completed_at is not null and error_code is not null
      and billing_state in ('not_billable', 'unknown'))
  ),
  check (
    (billing_state = 'reported' and cost_micros is not null)
    or (billing_state in ('pending', 'not_billable', 'unknown')
      and cost_micros is null)
  ),
  check (
    (status = 'prepared' and billing_state = 'pending')
    or (status = 'succeeded' and billing_state in ('reported', 'unknown'))
    or (status in ('rejected', 'failed')
      and billing_state = 'not_billable')
    or (status = 'indeterminate' and billing_state = 'unknown')
  )
);

create index edit_provider_calls_owner_time_idx
  on public.edit_provider_calls(profile_id, created_at desc);

create or replace function public.edit_provider_result_manifest_valid(
  p_profile_id uuid,
  p_job_id uuid,
  p_result jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_byte_size bigint;
  v_width integer;
  v_height integer;
  v_input_units bigint;
  v_output_units bigint;
  v_cost_micros bigint;
  v_billing_state text;
begin
  if p_result is null
    or jsonb_typeof(p_result) is distinct from 'object'
    or octet_length(p_result::text) > 65536
    or (select count(*) from jsonb_object_keys(p_result)) <> 14
    or not (
      p_result ? 'schema'
      and p_result ? 'providerRequestId'
      and p_result ? 'outputStorageBucket'
      and p_result ? 'outputStoragePath'
      and p_result ? 'outputMimeType'
      and p_result ? 'outputByteSize'
      and p_result ? 'outputSha256'
      and p_result ? 'width'
      and p_result ? 'height'
      and p_result ? 'inputUnits'
      and p_result ? 'outputUnits'
      and p_result ? 'costMicros'
      and p_result ? 'billingState'
      and p_result ? 'providerMeta'
    )
    or p_result ->> 'schema' is distinct from 'edit-provider-result-v1'
    or (
      p_result -> 'providerRequestId' <> 'null'::jsonb
      and (
        jsonb_typeof(p_result -> 'providerRequestId') is distinct from 'string'
        or char_length(p_result ->> 'providerRequestId') not between 1 and 200
      )
    )
    or p_result ->> 'outputStorageBucket' is distinct from 'edits'
    or coalesce(p_result ->> 'outputMimeType', '') not in (
      'image/jpeg', 'image/png', 'image/webp'
    )
    or coalesce(p_result ->> 'outputByteSize', '') !~ '^[0-9]{1,8}$'
    or coalesce(p_result ->> 'outputSha256', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_result ->> 'inputUnits', '') !~ '^[0-9]{1,12}$'
    or coalesce(p_result ->> 'outputUnits', '') !~ '^[0-9]{1,12}$'
    or jsonb_typeof(p_result -> 'providerMeta') is distinct from 'object'
    or octet_length((p_result -> 'providerMeta')::text) > 16384 then
    return false;
  end if;

  v_byte_size := (p_result ->> 'outputByteSize')::bigint;
  v_input_units := (p_result ->> 'inputUnits')::bigint;
  v_output_units := (p_result ->> 'outputUnits')::bigint;
  if p_result -> 'width' = 'null'::jsonb
    and p_result -> 'height' = 'null'::jsonb then
    v_width := null;
    v_height := null;
  elsif coalesce(p_result ->> 'width', '') ~ '^[0-9]{1,5}$'
    and coalesce(p_result ->> 'height', '') ~ '^[0-9]{1,5}$' then
    v_width := (p_result ->> 'width')::integer;
    v_height := (p_result ->> 'height')::integer;
  else
    return false;
  end if;

  v_billing_state := p_result ->> 'billingState';
  if v_billing_state = 'reported'
    and coalesce(p_result ->> 'costMicros', '') ~ '^[0-9]{1,15}$' then
    v_cost_micros := (p_result ->> 'costMicros')::bigint;
  elsif v_billing_state = 'unknown'
    and p_result -> 'costMicros' = 'null'::jsonb then
    v_cost_micros := null;
  else
    return false;
  end if;

  if (v_billing_state = 'reported'
      and p_result -> 'providerMeta' ->> 'pricingStatus'
        is distinct from 'priced')
    or (v_billing_state = 'unknown'
      and p_result -> 'providerMeta' ->> 'pricingStatus'
        is distinct from 'unpriced') then
    return false;
  end if;

  return v_byte_size between 1 and 26214400
    and v_input_units >= 0
    and v_output_units >= 0
    and (v_cost_micros is null or v_cost_micros >= 0)
    and (v_width is null or v_width between 1 and 20000)
    and (v_height is null or v_height between 1 and 20000)
    and p_result ->> 'outputStoragePath' =
      public.edit_output_storage_path(
        p_profile_id,
        p_job_id,
        p_result ->> 'outputMimeType'
      );
exception when others then
  return false;
end;
$$;

create or replace function public.guard_edit_quota_terminal_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state in ('charged', 'released') and new is distinct from old then
    raise exception 'terminal_edit_quota_reservation_is_immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger edit_quota_terminal_state_guard
before update on public.edit_quota_reservations
for each row execute function public.guard_edit_quota_terminal_state();

create or replace function public.guard_edit_provider_terminal_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('succeeded', 'rejected', 'failed')
    and new is distinct from old then
    raise exception 'terminal_edit_provider_call_is_immutable'
      using errcode = '55000';
  end if;
  if old.status = 'indeterminate'
    and new.status not in ('indeterminate', 'succeeded') then
    raise exception 'indeterminate_edit_provider_call_requires_recovery'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger edit_provider_terminal_state_guard
before update on public.edit_provider_calls
for each row execute function public.guard_edit_provider_terminal_state();

create or replace function public.guard_edit_job_terminal_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('delivered', 'failed') and new is distinct from old then
    raise exception 'terminal_edit_generation_job_is_immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger edit_job_terminal_state_guard
before update on public.edit_generation_jobs
for each row execute function public.guard_edit_job_terminal_state();

alter table public.edit_generation_policy enable row level security;
alter table public.edit_generation_jobs enable row level security;
alter table public.edit_quota_reservations enable row level security;
alter table public.edit_provider_calls enable row level security;

create policy "edit generation jobs: owner read"
  on public.edit_generation_jobs
  for select to authenticated using ((select auth.uid()) = profile_id);
create policy "edit quota reservations: owner read"
  on public.edit_quota_reservations
  for select to authenticated using ((select auth.uid()) = profile_id);

revoke all on public.edit_generation_policy
  from public, anon, authenticated, service_role;
revoke all on public.edit_generation_jobs
  from public, anon, authenticated, service_role;
revoke all on public.edit_quota_reservations
  from public, anon, authenticated, service_role;
revoke all on public.edit_provider_calls
  from public, anon, authenticated, service_role;
grant select on public.edit_generation_jobs to authenticated;
grant select on public.edit_quota_reservations to authenticated;

create or replace function public.reserve_edit_generation(
  p_profile_id uuid,
  p_idempotency_key text,
  p_request_manifest jsonb
)
returns table (
  job_id uuid,
  job_status text,
  replayed boolean,
  request_hash text,
  quota_state text,
  plan_snapshot text,
  quota_period_start date,
  output_storage_paths text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_quota public.edit_quota_reservations%rowtype;
  v_profile public.profiles%rowtype;
  v_policy public.edit_generation_policy%rowtype;
  v_hash text;
  v_period_start date;
  v_used integer;
begin
  if p_profile_id is null
    or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 8 and 128
    or not public.edit_request_manifest_valid(p_request_manifest) then
    raise exception 'invalid_edit_generation_request' using errcode = '22023';
  end if;
  v_hash := public.edit_json_sha256(p_request_manifest);
  v_period_start := date_trunc('month', now() at time zone 'UTC')::date;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_profile_id::text, 0)
  );
  select * into v_job
  from public.edit_generation_jobs j
  where j.profile_id = p_profile_id
    and j.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_job.request_hash <> v_hash
      or v_job.request_manifest <> p_request_manifest then
      raise exception 'edit_generation_idempotency_conflict'
        using errcode = '23505';
    end if;
    select * into strict v_quota
    from public.edit_quota_reservations q
    where q.job_id = v_job.id and q.profile_id = p_profile_id;
    return query select
      v_job.id, v_job.status, true, v_job.request_hash,
      v_quota.state, v_quota.plan_snapshot, v_quota.period_start,
      public.edit_output_storage_paths(v_job.profile_id, v_job.id);
    return;
  end if;

  select * into v_profile
  from public.profiles p
  where p.id = p_profile_id
  for update;
  if not found or v_profile.plan not in ('free', 'plus') then
    raise exception 'edit_quota_profile_unavailable' using errcode = 'P0002';
  end if;
  select * into strict v_policy
  from public.edit_generation_policy p
  where p.policy_key = 'default'
  for share;

  if v_profile.plan = 'free' then
    select count(*)::integer into v_used
    from public.edit_quota_reservations q
    where q.profile_id = p_profile_id
      and q.period_start = v_period_start
      and q.state in ('held', 'charged');
    if v_used >= v_policy.free_monthly_limit then
      raise exception 'edit_quota_exhausted' using errcode = 'P0001';
    end if;
  end if;

  insert into public.edit_generation_jobs (
    profile_id, idempotency_key, request_manifest, request_hash,
    provider, model_ref, prompt_version, reservation_expires_at
  ) values (
    p_profile_id, p_idempotency_key, p_request_manifest, v_hash,
    p_request_manifest ->> 'provider',
    p_request_manifest ->> 'modelRef',
    p_request_manifest ->> 'promptVersion',
    now() + pg_catalog.make_interval(secs => v_policy.reservation_ttl_seconds)
  ) returning * into v_job;

  insert into public.edit_quota_reservations (
    job_id, profile_id, period_start, plan_snapshot, free_limit_snapshot
  ) values (
    v_job.id, p_profile_id, v_period_start, v_profile.plan,
    v_policy.free_monthly_limit
  ) returning * into v_quota;

  return query select
    v_job.id, v_job.status, false, v_job.request_hash,
    v_quota.state, v_quota.plan_snapshot, v_quota.period_start,
    public.edit_output_storage_paths(v_job.profile_id, v_job.id);
end;
$$;

create or replace function public.get_edit_generation_state(
  p_job_id uuid,
  p_profile_id uuid
)
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'jobId', j.id,
    'status', j.status,
    'requestHash', j.request_hash,
    'attemptNumber', j.attempt_number,
    'leaseToken', j.lease_token,
    'leaseExpiresAt', j.lease_expires_at,
    'reservationExpiresAt', j.reservation_expires_at,
    'outputStorageBucket', j.output_storage_bucket,
    'outputStoragePath', j.output_storage_path,
    'outputMimeType', j.output_mime_type,
    'outputByteSize', j.output_byte_size,
    'outputSha256', j.output_content_sha256,
    'outputWidth', j.output_width,
    'outputHeight', j.output_height,
    'resultHash', j.result_hash,
    'errorCode', j.error_code,
    'quota', jsonb_build_object(
      'state', q.state,
      'periodStart', q.period_start,
      'planSnapshot', q.plan_snapshot,
      'freeLimitSnapshot', q.free_limit_snapshot
    ),
    'providerCall', case when c.id is null then null else jsonb_build_object(
      'id', c.id,
      'status', c.status,
      'attemptNumber', c.attempt_number,
      'provider', c.provider,
      'modelRef', c.model_ref,
      'requestHash', c.request_hash,
      'resultHash', c.result_hash,
      'providerRequestId', c.provider_request_id,
      'inputUnits', c.input_units,
      'outputUnits', c.output_units,
      'costMicros', c.cost_micros,
      'billingState', c.billing_state,
      'errorCode', c.error_code
    ) end,
    'outputStoragePaths', public.edit_output_storage_paths(j.profile_id, j.id)
  )
  from public.edit_generation_jobs j
  join public.edit_quota_reservations q
    on q.job_id = j.id and q.profile_id = j.profile_id
  left join public.edit_provider_calls c
    on c.job_id = j.id and c.profile_id = j.profile_id
  where j.id = p_job_id and j.profile_id = p_profile_id
$$;

create or replace function public.claim_edit_generation(
  p_job_id uuid,
  p_profile_id uuid,
  p_lease_token uuid
)
returns table (
  claimed boolean,
  replayed boolean,
  job_status text,
  attempt_number integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_quota public.edit_quota_reservations%rowtype;
  v_policy public.edit_generation_policy%rowtype;
begin
  if p_job_id is null or p_profile_id is null or p_lease_token is null then
    raise exception 'invalid_edit_generation_claim' using errcode = '22023';
  end if;
  select * into v_job
  from public.edit_generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_generation_job_not_found' using errcode = 'P0002';
  end if;
  select * into strict v_quota
  from public.edit_quota_reservations q
  where q.job_id = p_job_id and q.profile_id = p_profile_id
  for update;
  select * into strict v_policy
  from public.edit_generation_policy p
  where p.policy_key = 'default';

  if v_job.status = 'processing'
    and v_job.lease_token = p_lease_token
    and v_job.lease_expires_at > now() then
    return query select true, true, v_job.status, v_job.attempt_number,
      v_job.lease_token, v_job.lease_expires_at;
    return;
  end if;
  if v_job.status not in ('reserved', 'processing') then
    return query select false, false, v_job.status, v_job.attempt_number,
      v_job.lease_token, v_job.lease_expires_at;
    return;
  end if;
  if v_quota.state <> 'held' then
    raise exception 'edit_quota_state_corrupt' using errcode = '23514';
  end if;
  if v_job.status = 'reserved' and v_job.reservation_expires_at <= now() then
    update public.edit_quota_reservations
    set state = 'released', released_at = now(), updated_at = now()
    where job_id = p_job_id;
    update public.edit_generation_jobs
    set status = 'failed', error_code = 'edit_reservation_expired',
        error_detail = 'reservation expired before provider work',
        completed_at = now(), updated_at = now()
    where id = p_job_id;
    return query select false, false, 'failed'::text,
      v_job.attempt_number, null::uuid, null::timestamptz;
    return;
  end if;
  if v_job.status = 'processing' and v_job.lease_expires_at > now() then
    return query select false, false, v_job.status, v_job.attempt_number,
      v_job.lease_token, v_job.lease_expires_at;
    return;
  end if;
  if exists (
    select 1 from public.edit_provider_calls c where c.job_id = p_job_id
  ) then
    raise exception 'pre_provider_edit_claim_has_call' using errcode = '23514';
  end if;

  update public.edit_generation_jobs as j
  set status = 'processing',
      attempt_number = j.attempt_number + 1,
      lease_token = p_lease_token,
      lease_expires_at = now() +
        pg_catalog.make_interval(secs => v_policy.lease_seconds),
      started_at = coalesce(j.started_at, now()),
      error_code = null,
      error_detail = null,
      updated_at = now()
  where j.id = p_job_id
  returning * into v_job;
  return query select true, false, v_job.status, v_job.attempt_number,
    v_job.lease_token, v_job.lease_expires_at;
end;
$$;

create or replace function public.begin_edit_provider_call(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_number integer,
  p_lease_token uuid,
  p_call_id uuid,
  p_request_hash text
)
returns table (
  invoke_allowed boolean,
  call_id uuid,
  call_status text,
  job_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_call public.edit_provider_calls%rowtype;
  v_policy public.edit_generation_policy%rowtype;
begin
  if p_attempt_number is null or p_attempt_number < 1
    or p_lease_token is null or p_call_id is null
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_edit_provider_call' using errcode = '22023';
  end if;
  select * into v_job
  from public.edit_generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_generation_job_not_found' using errcode = 'P0002';
  end if;
  if p_request_hash <> v_job.request_hash then
    raise exception 'edit_provider_request_hash_mismatch'
      using errcode = '23514';
  end if;
  select * into v_call
  from public.edit_provider_calls c
  where c.job_id = p_job_id
  for update;
  if found then
    if v_call.id <> p_call_id
      or v_call.profile_id <> p_profile_id
      or v_call.attempt_number <> p_attempt_number
      or v_call.provider <> v_job.provider
      or v_call.model_ref <> v_job.model_ref
      or v_call.request_hash <> p_request_hash then
      raise exception 'edit_provider_call_conflict' using errcode = '23505';
    end if;
    return query select false, v_call.id, v_call.status, v_job.status;
    return;
  end if;
  if v_job.status <> 'processing'
    or v_job.attempt_number <> p_attempt_number
    or v_job.lease_token <> p_lease_token
    or v_job.lease_expires_at <= now() then
    raise exception 'edit_generation_lease_lost' using errcode = '40001';
  end if;
  select * into strict v_policy
  from public.edit_generation_policy p where p.policy_key = 'default';

  insert into public.edit_provider_calls (
    id, job_id, profile_id, attempt_number, provider, model_ref, request_hash
  ) values (
    p_call_id, p_job_id, p_profile_id, p_attempt_number,
    v_job.provider, v_job.model_ref, p_request_hash
  ) returning * into v_call;
  update public.edit_generation_jobs
  set status = 'provider_prepared',
      lease_expires_at = now() +
        pg_catalog.make_interval(secs => v_policy.lease_seconds),
      updated_at = now()
  where id = p_job_id;
  return query select true, v_call.id, v_call.status,
    'provider_prepared'::text;
end;
$$;

create or replace function public.record_edit_provider_result(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_number integer,
  p_lease_token uuid,
  p_call_id uuid,
  p_result_manifest jsonb
)
returns table (
  captured boolean,
  replayed boolean,
  job_status text,
  result_hash text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_call public.edit_provider_calls%rowtype;
  v_result_hash text;
begin
  if p_attempt_number is null or p_attempt_number < 1
    or p_lease_token is null or p_call_id is null
    or not public.edit_provider_result_manifest_valid(
      p_profile_id, p_job_id, p_result_manifest
    ) then
    raise exception 'invalid_edit_provider_result' using errcode = '22023';
  end if;
  v_result_hash := public.edit_json_sha256(p_result_manifest);
  select * into v_job
  from public.edit_generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_generation_job_not_found' using errcode = 'P0002';
  end if;
  select * into v_call
  from public.edit_provider_calls c
  where c.id = p_call_id and c.job_id = p_job_id
    and c.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_provider_call_not_found' using errcode = 'P0002';
  end if;

  if v_call.status = 'succeeded' then
    if v_call.result_hash <> v_result_hash
      or v_call.result_manifest <> p_result_manifest
      or v_job.result_hash <> v_result_hash
      or v_job.status not in ('result_captured', 'delivered') then
      raise exception 'edit_provider_result_conflict' using errcode = '23505';
    end if;
    return query select true, true, v_job.status, v_result_hash;
    return;
  end if;
  if v_call.status <> 'prepared'
    or v_call.attempt_number <> p_attempt_number
    or v_job.status <> 'provider_prepared'
    or v_job.attempt_number <> p_attempt_number
    or v_job.lease_token <> p_lease_token
    or v_job.lease_expires_at <= now() then
    raise exception 'edit_generation_lease_lost' using errcode = '40001';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'edits'
      and o.name = p_result_manifest ->> 'outputStoragePath'
  ) then
    raise exception 'edit_output_object_missing' using errcode = 'P0002';
  end if;

  update public.edit_provider_calls
  set status = 'succeeded',
      result_manifest = p_result_manifest,
      result_hash = v_result_hash,
      provider_request_id = nullif(
        p_result_manifest ->> 'providerRequestId', ''
      ),
      input_units = (p_result_manifest ->> 'inputUnits')::bigint,
      output_units = (p_result_manifest ->> 'outputUnits')::bigint,
      cost_micros = (p_result_manifest ->> 'costMicros')::bigint,
      billing_state = p_result_manifest ->> 'billingState',
      provider_meta = p_result_manifest -> 'providerMeta',
      provider_completed_at = now(),
      updated_at = now()
  where id = p_call_id;
  update public.edit_generation_jobs
  set status = 'result_captured',
      lease_token = null,
      lease_expires_at = null,
      output_storage_bucket = 'edits',
      output_storage_path = p_result_manifest ->> 'outputStoragePath',
      output_mime_type = p_result_manifest ->> 'outputMimeType',
      output_byte_size = (p_result_manifest ->> 'outputByteSize')::bigint,
      output_content_sha256 = p_result_manifest ->> 'outputSha256',
      output_width = (p_result_manifest ->> 'width')::integer,
      output_height = (p_result_manifest ->> 'height')::integer,
      result_hash = v_result_hash,
      provider_response_id = nullif(
        p_result_manifest ->> 'providerRequestId', ''
      ),
      provider_completed_at = now(),
      result_captured_at = now(),
      error_code = null,
      error_detail = null,
      updated_at = now()
  where id = p_job_id;
  return query select true, false, 'result_captured'::text, v_result_hash;
end;
$$;

create or replace function public.recover_edit_provider_result(
  p_job_id uuid,
  p_profile_id uuid,
  p_call_id uuid,
  p_result_manifest jsonb
)
returns table (
  captured boolean,
  replayed boolean,
  job_status text,
  result_hash text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_call public.edit_provider_calls%rowtype;
  v_quota public.edit_quota_reservations%rowtype;
  v_result_hash text;
begin
  if p_call_id is null
    or not public.edit_provider_result_manifest_valid(
      p_profile_id, p_job_id, p_result_manifest
    )
    or p_result_manifest ->> 'billingState' <> 'unknown'
    or p_result_manifest -> 'costMicros' <> 'null'::jsonb
    or p_result_manifest -> 'providerMeta' ->
      'recoveredFromDeterministicStorage' is distinct from 'true'::jsonb then
    raise exception 'invalid_edit_provider_recovery' using errcode = '22023';
  end if;
  v_result_hash := public.edit_json_sha256(p_result_manifest);
  select * into v_job
  from public.edit_generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_generation_job_not_found' using errcode = 'P0002';
  end if;
  select * into v_call
  from public.edit_provider_calls c
  where c.id = p_call_id and c.job_id = p_job_id
    and c.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_provider_call_not_found' using errcode = 'P0002';
  end if;
  select * into strict v_quota
  from public.edit_quota_reservations q
  where q.job_id = p_job_id and q.profile_id = p_profile_id
  for update;

  if v_call.status = 'succeeded' then
    if v_call.result_hash <> v_result_hash
      or v_call.result_manifest <> p_result_manifest
      or v_job.result_hash <> v_result_hash
      or v_job.status not in ('result_captured', 'delivered') then
      raise exception 'edit_provider_result_conflict' using errcode = '23505';
    end if;
    return query select true, true, v_job.status, v_result_hash;
    return;
  end if;
  if v_job.status not in ('provider_prepared', 'indeterminate')
    or v_call.status not in ('prepared', 'indeterminate')
    or v_quota.state <> 'held' then
    raise exception 'edit_provider_result_not_recoverable'
      using errcode = '55000';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'edits'
      and o.name = p_result_manifest ->> 'outputStoragePath'
  ) then
    raise exception 'edit_output_object_missing' using errcode = 'P0002';
  end if;

  update public.edit_provider_calls
  set status = 'succeeded',
      result_manifest = p_result_manifest,
      result_hash = v_result_hash,
      provider_request_id = nullif(
        p_result_manifest ->> 'providerRequestId', ''
      ),
      input_units = (p_result_manifest ->> 'inputUnits')::bigint,
      output_units = (p_result_manifest ->> 'outputUnits')::bigint,
      cost_micros = null,
      billing_state = 'unknown',
      provider_meta = p_result_manifest -> 'providerMeta',
      error_code = null,
      error_detail = null,
      provider_completed_at = now(),
      updated_at = now()
  where id = p_call_id;
  update public.edit_generation_jobs
  set status = 'result_captured',
      lease_token = null,
      lease_expires_at = null,
      output_storage_bucket = 'edits',
      output_storage_path = p_result_manifest ->> 'outputStoragePath',
      output_mime_type = p_result_manifest ->> 'outputMimeType',
      output_byte_size = (p_result_manifest ->> 'outputByteSize')::bigint,
      output_content_sha256 = p_result_manifest ->> 'outputSha256',
      output_width = (p_result_manifest ->> 'width')::integer,
      output_height = (p_result_manifest ->> 'height')::integer,
      result_hash = v_result_hash,
      provider_response_id = nullif(
        p_result_manifest ->> 'providerRequestId', ''
      ),
      provider_completed_at = now(),
      result_captured_at = now(),
      indeterminate_at = null,
      error_code = null,
      error_detail = null,
      updated_at = now()
  where id = p_job_id;
  return query select true, false, 'result_captured'::text, v_result_hash;
end;
$$;

create or replace function public.fail_edit_generation_pre_provider(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_number integer,
  p_lease_token uuid,
  p_error_code text,
  p_error_detail text
)
returns table (
  failed boolean,
  replayed boolean,
  job_status text,
  quota_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_quota public.edit_quota_reservations%rowtype;
  v_error_code text := left(coalesce(p_error_code, ''), 100);
  v_error_detail text := left(coalesce(p_error_detail, ''), 1000);
begin
  if p_attempt_number is null or p_attempt_number < 1
    or p_lease_token is null or char_length(v_error_code) < 1 then
    raise exception 'invalid_edit_pre_provider_failure'
      using errcode = '22023';
  end if;
  select * into v_job
  from public.edit_generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_generation_job_not_found' using errcode = 'P0002';
  end if;
  select * into strict v_quota
  from public.edit_quota_reservations q
  where q.job_id = p_job_id and q.profile_id = p_profile_id
  for update;

  if v_job.status = 'failed' then
    if v_job.attempt_number = p_attempt_number
      and v_job.error_code = v_error_code
      and coalesce(v_job.error_detail, '') = v_error_detail
      and v_quota.state = 'released'
      and not exists (
        select 1 from public.edit_provider_calls c where c.job_id = p_job_id
      ) then
      return query select true, true, v_job.status, v_quota.state;
      return;
    end if;
    raise exception 'edit_failure_conflict' using errcode = '23505';
  end if;
  if v_job.status <> 'processing'
    or v_job.attempt_number <> p_attempt_number
    or v_job.lease_token <> p_lease_token
    or v_job.lease_expires_at <= now() then
    raise exception 'edit_generation_lease_lost' using errcode = '40001';
  end if;
  if v_quota.state <> 'held' or exists (
    select 1 from public.edit_provider_calls c where c.job_id = p_job_id
  ) then
    raise exception 'edit_pre_provider_failure_has_call'
      using errcode = '23514';
  end if;

  update public.edit_quota_reservations
  set state = 'released', released_at = now(), updated_at = now()
  where job_id = p_job_id;
  update public.edit_generation_jobs
  set status = 'failed',
      lease_token = null,
      lease_expires_at = null,
      error_code = v_error_code,
      error_detail = v_error_detail,
      completed_at = now(),
      updated_at = now()
  where id = p_job_id;
  return query select true, false, 'failed'::text, 'released'::text;
end;
$$;

create or replace function public.record_edit_provider_failure(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_number integer,
  p_lease_token uuid,
  p_call_id uuid,
  p_outcome text,
  p_error_code text,
  p_error_detail text,
  p_provider_request_id text default null
)
returns table (
  recorded boolean,
  replayed boolean,
  job_status text,
  call_status text,
  quota_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_call public.edit_provider_calls%rowtype;
  v_quota public.edit_quota_reservations%rowtype;
  v_error_code text := left(coalesce(p_error_code, ''), 100);
  v_error_detail text := left(coalesce(p_error_detail, ''), 1000);
  v_provider_request_id text := nullif(p_provider_request_id, '');
  v_job_status text;
  v_quota_state text;
  v_billing_state text;
begin
  if p_attempt_number is null or p_attempt_number < 1
    or p_lease_token is null or p_call_id is null
    or p_outcome not in ('rejected', 'failed', 'indeterminate')
    or char_length(v_error_code) < 1 then
    raise exception 'invalid_edit_provider_failure' using errcode = '22023';
  end if;
  select * into v_job
  from public.edit_generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_generation_job_not_found' using errcode = 'P0002';
  end if;
  select * into v_call
  from public.edit_provider_calls c
  where c.id = p_call_id and c.job_id = p_job_id
    and c.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_provider_call_not_found' using errcode = 'P0002';
  end if;
  select * into strict v_quota
  from public.edit_quota_reservations q
  where q.job_id = p_job_id and q.profile_id = p_profile_id
  for update;

  if v_call.status <> 'prepared' then
    if v_call.status = p_outcome
      and v_call.attempt_number = p_attempt_number
      and v_call.error_code = v_error_code
      and coalesce(v_call.error_detail, '') = v_error_detail
      and v_call.provider_request_id is not distinct from v_provider_request_id then
      return query select true, true, v_job.status, v_call.status, v_quota.state;
      return;
    end if;
    raise exception 'edit_provider_failure_conflict' using errcode = '23505';
  end if;
  if v_job.status <> 'provider_prepared'
    or v_job.attempt_number <> p_attempt_number
    or v_job.lease_token <> p_lease_token
    or v_job.lease_expires_at <= now()
    or v_call.attempt_number <> p_attempt_number
    or v_quota.state <> 'held' then
    raise exception 'edit_generation_lease_lost' using errcode = '40001';
  end if;

  v_billing_state := case when p_outcome = 'indeterminate'
    then 'unknown' else 'not_billable' end;
  v_job_status := case when p_outcome = 'indeterminate'
    then 'indeterminate' else 'failed' end;
  v_quota_state := case when p_outcome = 'indeterminate'
    then 'held' else 'released' end;

  update public.edit_provider_calls
  set status = p_outcome,
      provider_request_id = v_provider_request_id,
      billing_state = v_billing_state,
      error_code = v_error_code,
      error_detail = v_error_detail,
      provider_completed_at = now(),
      updated_at = now()
  where id = p_call_id;
  if v_quota_state = 'released' then
    update public.edit_quota_reservations
    set state = 'released', released_at = now(), updated_at = now()
    where job_id = p_job_id;
  end if;
  update public.edit_generation_jobs
  set status = v_job_status,
      lease_token = null,
      lease_expires_at = null,
      error_code = v_error_code,
      error_detail = v_error_detail,
      provider_response_id = v_provider_request_id,
      provider_completed_at = now(),
      indeterminate_at = case when v_job_status = 'indeterminate'
        then now() else null end,
      completed_at = case when v_job_status = 'failed' then now() else null end,
      updated_at = now()
  where id = p_job_id;
  return query select true, false, v_job_status, p_outcome, v_quota_state;
end;
$$;

create or replace function public.settle_edit_generation(
  p_job_id uuid,
  p_profile_id uuid,
  p_output_storage_path text,
  p_output_sha256 text
)
returns table (
  delivered boolean,
  replayed boolean,
  job_status text,
  quota_state text,
  taste_event_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_quota public.edit_quota_reservations%rowtype;
  v_taste_event_id uuid;
begin
  if coalesce(p_output_storage_path, '') = ''
    or coalesce(p_output_sha256, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_edit_delivery' using errcode = '22023';
  end if;
  select * into v_job
  from public.edit_generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_generation_job_not_found' using errcode = 'P0002';
  end if;
  select * into strict v_quota
  from public.edit_quota_reservations q
  where q.job_id = p_job_id and q.profile_id = p_profile_id
  for update;

  if v_job.status = 'delivered' then
    if v_job.output_storage_path <> p_output_storage_path
      or v_job.output_content_sha256 <> p_output_sha256
      or v_quota.state <> 'charged'
      or v_job.taste_event_id is null then
      raise exception 'edit_delivery_conflict' using errcode = '23505';
    end if;
    return query select true, true, v_job.status, v_quota.state,
      v_job.taste_event_id;
    return;
  end if;
  if v_job.status <> 'result_captured'
    or v_job.output_storage_path <> p_output_storage_path
    or v_job.output_content_sha256 <> p_output_sha256
    or v_quota.state <> 'held' then
    raise exception 'edit_result_not_settleable' using errcode = '55000';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'edits' and o.name = p_output_storage_path
  ) then
    raise exception 'edit_output_object_missing' using errcode = 'P0002';
  end if;

  insert into public.taste_events(profile_id, event_type, subject)
  values (
    p_profile_id,
    'edit_generated',
    jsonb_build_object(
      'editJobId', v_job.id,
      'kind', v_job.request_manifest ->> 'kind',
      'model', v_job.model_ref,
      'storagePath', v_job.output_storage_path,
      'outputSha256', v_job.output_content_sha256
    )
  ) returning id into v_taste_event_id;
  update public.edit_quota_reservations
  set state = 'charged', charged_at = now(), updated_at = now()
  where job_id = p_job_id;
  update public.edit_generation_jobs
  set status = 'delivered',
      taste_event_id = v_taste_event_id,
      delivered_at = now(),
      completed_at = now(),
      updated_at = now()
  where id = p_job_id;
  return query select true, false, 'delivered'::text, 'charged'::text,
    v_taste_event_id;
end;
$$;

create or replace function public.release_indeterminate_edit_generation(
  p_job_id uuid,
  p_profile_id uuid
)
returns table (
  released boolean,
  replayed boolean,
  job_status text,
  quota_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_call public.edit_provider_calls%rowtype;
  v_quota public.edit_quota_reservations%rowtype;
  v_policy public.edit_generation_policy%rowtype;
begin
  select * into v_job
  from public.edit_generation_jobs j
  where j.id = p_job_id and j.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_generation_job_not_found' using errcode = 'P0002';
  end if;
  select * into v_call
  from public.edit_provider_calls c
  where c.job_id = p_job_id and c.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'edit_provider_call_not_found' using errcode = 'P0002';
  end if;
  select * into strict v_quota
  from public.edit_quota_reservations q
  where q.job_id = p_job_id and q.profile_id = p_profile_id
  for update;
  select * into strict v_policy
  from public.edit_generation_policy p
  where p.policy_key = 'default';

  if v_job.status = 'failed'
    and v_job.error_code = 'edit_indeterminate_released'
    and v_call.status = 'indeterminate'
    and v_quota.state = 'released' then
    return query select true, true, v_job.status, v_quota.state;
    return;
  end if;
  if v_job.status <> 'indeterminate'
    or v_call.status <> 'indeterminate'
    or v_quota.state <> 'held' then
    raise exception 'edit_indeterminate_not_releasable'
      using errcode = '55000';
  end if;
  if v_job.indeterminate_at + pg_catalog.make_interval(
      secs => v_policy.indeterminate_release_seconds
    ) > now() then
    raise exception 'edit_indeterminate_reconciliation_pending'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'edits'
      and o.name = any(public.edit_output_storage_paths(p_profile_id, p_job_id))
  ) then
    raise exception 'edit_cleanup_object_still_exists' using errcode = '55000';
  end if;

  update public.edit_quota_reservations
  set state = 'released', released_at = now(), updated_at = now()
  where job_id = p_job_id;
  update public.edit_generation_jobs
  set status = 'failed',
      indeterminate_at = null,
      error_code = 'edit_indeterminate_released',
      error_detail = 'deterministic output candidates absent after reconciliation',
      completed_at = now(),
      updated_at = now()
  where id = p_job_id;
  return query select true, false, 'failed'::text, 'released'::text;
end;
$$;

create or replace function public.reap_stale_edit_generation(
  p_limit integer default 25
)
returns table (
  job_id uuid,
  prior_status text,
  resulting_status text,
  quota_state text,
  action text,
  output_storage_paths text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.edit_generation_jobs%rowtype;
  v_call public.edit_provider_calls%rowtype;
  v_quota public.edit_quota_reservations%rowtype;
  v_policy public.edit_generation_policy%rowtype;
  v_prior_status text;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_edit_reaper_limit' using errcode = '22023';
  end if;
  select * into strict v_policy
  from public.edit_generation_policy p where p.policy_key = 'default';

  for v_job in
    select j.*
    from public.edit_generation_jobs j
    where (j.status = 'reserved' and j.reservation_expires_at <= now())
      or (
        j.status in ('processing', 'provider_prepared')
        and j.lease_expires_at <= now()
      )
    order by coalesce(j.lease_expires_at, j.reservation_expires_at), j.id
    for update skip locked
    limit p_limit
  loop
    v_prior_status := v_job.status;
    select * into strict v_quota
    from public.edit_quota_reservations q
    where q.job_id = v_job.id and q.profile_id = v_job.profile_id
    for update;

    if v_job.status = 'reserved' then
      if v_quota.state = 'held' then
        update public.edit_quota_reservations
        set state = 'released', released_at = now(), updated_at = now()
        where job_id = v_job.id;
      end if;
      update public.edit_generation_jobs
      set status = 'failed',
          error_code = 'edit_reservation_expired',
          error_detail = 'reservation expired before provider work',
          completed_at = now(),
          updated_at = now()
      where id = v_job.id;
      return query select
        v_job.id, v_prior_status, 'failed'::text, 'released'::text,
        'reservation_released'::text,
        public.edit_output_storage_paths(v_job.profile_id, v_job.id);
      continue;
    end if;

    select * into v_call
    from public.edit_provider_calls c
    where c.job_id = v_job.id
    for update;
    if v_job.status = 'processing' and not found then
      update public.edit_generation_jobs
      set status = 'reserved',
          lease_token = null,
          lease_expires_at = null,
          reservation_expires_at = now() +
            pg_catalog.make_interval(secs => v_policy.retry_grace_seconds),
          error_code = 'edit_pre_provider_lease_requeued',
          error_detail = 'expired before provider-call reservation',
          updated_at = now()
      where id = v_job.id;
      return query select
        v_job.id, v_prior_status, 'reserved'::text, v_quota.state,
        'pre_provider_requeued'::text,
        public.edit_output_storage_paths(v_job.profile_id, v_job.id);
      continue;
    end if;

    if not found then
      update public.edit_quota_reservations
      set state = 'released', released_at = now(), updated_at = now()
      where job_id = v_job.id and state = 'held';
      update public.edit_generation_jobs
      set status = 'failed',
          lease_token = null,
          lease_expires_at = null,
          error_code = 'edit_provider_call_state_missing',
          error_detail = 'provider-prepared job had no provider-call row',
          completed_at = now(),
          updated_at = now()
      where id = v_job.id;
      return query select
        v_job.id, v_prior_status, 'failed'::text, 'released'::text,
        'corrupt_provider_state_released'::text,
        public.edit_output_storage_paths(v_job.profile_id, v_job.id);
      continue;
    end if;

    if v_call.status = 'prepared' then
      update public.edit_provider_calls
      set status = 'indeterminate',
          billing_state = 'unknown',
          error_code = 'edit_provider_outcome_indeterminate',
          error_detail = 'lease expired after durable provider-call reservation',
          provider_completed_at = now(),
          updated_at = now()
      where id = v_call.id;
      update public.edit_generation_jobs
      set status = 'indeterminate',
          lease_token = null,
          lease_expires_at = null,
          error_code = 'edit_provider_outcome_indeterminate',
          error_detail = 'recover exact deterministic output or release after cleanup',
          indeterminate_at = now(),
          updated_at = now()
      where id = v_job.id;
      return query select
        v_job.id, v_prior_status, 'indeterminate'::text, v_quota.state,
        'provider_outcome_indeterminate'::text,
        public.edit_output_storage_paths(v_job.profile_id, v_job.id);
      continue;
    end if;

    -- A terminal provider row with a stale active job can only result from
    -- out-of-band mutation. Fail closed without changing terminal evidence.
    update public.edit_generation_jobs
    set status = 'indeterminate',
        lease_token = null,
        lease_expires_at = null,
        error_code = 'edit_provider_state_mismatch',
        error_detail = 'terminal provider state did not atomically update job',
        indeterminate_at = now(),
        updated_at = now()
    where id = v_job.id;
    return query select
      v_job.id, v_prior_status, 'indeterminate'::text, v_quota.state,
      'provider_state_mismatch'::text,
      public.edit_output_storage_paths(v_job.profile_id, v_job.id);
  end loop;
end;
$$;

revoke all on function public.reserve_edit_generation(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.reserve_edit_generation(uuid, text, jsonb)
  to service_role;
revoke all on function public.get_edit_generation_state(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_edit_generation_state(uuid, uuid)
  to service_role;
revoke all on function public.claim_edit_generation(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_edit_generation(uuid, uuid, uuid)
  to service_role;
revoke all on function public.begin_edit_provider_call(
  uuid, uuid, integer, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.begin_edit_provider_call(
  uuid, uuid, integer, uuid, uuid, text
) to service_role;
revoke all on function public.record_edit_provider_result(
  uuid, uuid, integer, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.record_edit_provider_result(
  uuid, uuid, integer, uuid, uuid, jsonb
) to service_role;
revoke all on function public.recover_edit_provider_result(
  uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.recover_edit_provider_result(
  uuid, uuid, uuid, jsonb
) to service_role;
revoke all on function public.fail_edit_generation_pre_provider(
  uuid, uuid, integer, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.fail_edit_generation_pre_provider(
  uuid, uuid, integer, uuid, text, text
) to service_role;
revoke all on function public.record_edit_provider_failure(
  uuid, uuid, integer, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_edit_provider_failure(
  uuid, uuid, integer, uuid, uuid, text, text, text, text
) to service_role;
revoke all on function public.settle_edit_generation(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_edit_generation(uuid, uuid, text, text)
  to service_role;
revoke all on function public.release_indeterminate_edit_generation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.release_indeterminate_edit_generation(uuid, uuid)
  to service_role;
revoke all on function public.reap_stale_edit_generation(integer)
  from public, anon, authenticated;
grant execute on function public.reap_stale_edit_generation(integer)
  to service_role;

comment on table public.edit_generation_jobs is
  'Edit-only idempotency and delivery state; service-written, owner-readable.';
comment on table public.edit_quota_reservations is
  'One monthly quota hold per edit job; terminal charged/released rows are immutable.';
comment on table public.edit_provider_calls is
  'At-most-once edit provider-call ledger with deterministic-output recovery.';

commit;
