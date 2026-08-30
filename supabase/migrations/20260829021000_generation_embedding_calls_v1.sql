-- One durable row per generation-time embedding HTTP call. Retrieval-query
-- vectors may be staged for recovery; output-image vectors are never stored,
-- only a digest and usage/cost evidence.

create table if not exists public.generation_embedding_calls (
  id uuid primary key,
  job_id uuid not null,
  attempt_id uuid not null,
  profile_id uuid not null,
  purpose text not null check (
    purpose in ('reference_retrieval_query', 'anti_copy_output')
  ),
  candidate_index smallint not null check (candidate_index in (0, 1)),
  provider text not null default 'google' check (provider = 'google'),
  model_ref text not null default 'gemini-embedding-2'
    check (model_ref = 'gemini-embedding-2'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'prepared' check (
    status in (
      'prepared',
      'succeeded',
      'provider_rejected',
      'provider_failed',
      'indeterminate'
    )
  ),
  provider_request_id text,
  result_digest text check (
    result_digest is null or result_digest ~ '^[a-f0-9]{64}$'
  ),
  vector_payload jsonb,
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
  unique (job_id, purpose, candidate_index),
  unique (id, job_id, profile_id),
  foreign key (job_id, profile_id)
    references public.generation_jobs(id, profile_id)
    on delete cascade,
  foreign key (attempt_id, profile_id)
    references public.generation_attempts(id, profile_id)
    on delete cascade,
  check (
    (purpose = 'reference_retrieval_query' and candidate_index = 0)
    or purpose = 'anti_copy_output'
  ),
  check (
    (status = 'prepared' and provider_completed_at is null)
    or (status <> 'prepared' and provider_completed_at is not null)
  ),
  check (
    status <> 'succeeded'
    or (
      result_digest is not null
      and input_units is not null
      and output_units is not null
      and cost_micros is not null
    )
  ),
  check (
    vector_payload is null
    or (purpose = 'reference_retrieval_query' and status = 'succeeded')
  )
);

alter table public.generation_embedding_calls enable row level security;
revoke all on public.generation_embedding_calls from public, anon, authenticated;

create or replace function public.prevent_terminal_generation_embedding_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'prepared' and new is distinct from old then
    raise exception 'terminal_generation_embedding_call_is_immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger generation_embedding_call_terminal_immutable
before update on public.generation_embedding_calls
for each row execute function public.prevent_terminal_generation_embedding_mutation();

create or replace function public.reserve_scene_embedding_call(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_call_id uuid,
  p_purpose text,
  p_candidate_index integer,
  p_request_hash text
)
returns table (
  invoke_allowed boolean,
  embedding_call_id uuid,
  call_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_attempt public.generation_attempts%rowtype;
  v_existing public.generation_embedding_calls%rowtype;
begin
  if p_purpose not in ('reference_retrieval_query', 'anti_copy_output')
    or p_candidate_index not in (0, 1)
    or (p_purpose = 'reference_retrieval_query' and p_candidate_index <> 0)
    or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_scene_embedding_call' using errcode = '22023';
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
    or v_job.active_attempt_id <> p_attempt_id
    or v_attempt.lease_token <> p_lease_token
    or v_attempt.lease_expires_at <= now() then
    raise exception 'generation_lease_lost' using errcode = '40001';
  end if;

  if p_purpose = 'anti_copy_output' and not exists (
    select 1 from public.generation_provider_calls c
    where c.job_id = p_job_id
      and c.profile_id = p_profile_id
      and c.attempt_id = p_attempt_id
      and c.call_index = p_candidate_index
      and c.status = 'prepared'
  ) then
    raise exception 'anti_copy_candidate_call_not_prepared' using errcode = '23514';
  end if;

  select * into v_existing
  from public.generation_embedding_calls c
  where c.job_id = p_job_id
    and c.purpose = p_purpose
    and c.candidate_index = p_candidate_index
  for update;
  if found then
    if v_existing.request_hash <> p_request_hash then
      raise exception 'scene_embedding_call_conflict' using errcode = '23505';
    end if;
    return query select false, v_existing.id, v_existing.status;
    return;
  end if;

  insert into public.generation_embedding_calls (
    id,
    job_id,
    attempt_id,
    profile_id,
    purpose,
    candidate_index,
    request_hash
  ) values (
    p_call_id,
    p_job_id,
    p_attempt_id,
    p_profile_id,
    p_purpose,
    p_candidate_index,
    p_request_hash
  )
  returning * into v_existing;

  update public.generation_attempts
  set lease_expires_at = now() + interval '5 minutes'
  where id = p_attempt_id and profile_id = p_profile_id;

  return query select true, v_existing.id, v_existing.status;
end;
$$;

create or replace function public.record_scene_embedding_result(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_embedding_call_id uuid,
  p_result_digest text,
  p_vector_payload jsonb,
  p_provider_request_id text,
  p_input_units bigint,
  p_output_units bigint,
  p_cost_micros bigint,
  p_provider_meta jsonb default '{}'::jsonb
)
returns table (
  recorded boolean,
  replayed boolean,
  result_digest text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_attempt public.generation_attempts%rowtype;
  v_call public.generation_embedding_calls%rowtype;
  v_component jsonb;
  v_digest text;
begin
  if coalesce(p_input_units, 0) < 0
    or coalesce(p_output_units, 0) < 0
    or coalesce(p_cost_micros, 0) < 0 then
    raise exception 'invalid_scene_embedding_result' using errcode = '22023';
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
  from public.generation_embedding_calls c
  where c.id = p_embedding_call_id
    and c.job_id = p_job_id
    and c.attempt_id = p_attempt_id
    and c.profile_id = p_profile_id
  for update;
  if v_job.id is null or v_attempt.id is null or v_call.id is null then
    raise exception 'scene_embedding_call_not_found' using errcode = 'P0002';
  end if;

  if v_call.purpose = 'reference_retrieval_query' then
    if jsonb_typeof(p_vector_payload) <> 'array'
      or jsonb_array_length(p_vector_payload) <> 768
      or octet_length(p_vector_payload::text) > 65536 then
      raise exception 'invalid_retrieval_embedding_vector' using errcode = '22023';
    end if;
    for v_component in select value from jsonb_array_elements(p_vector_payload)
    loop
      if jsonb_typeof(v_component) <> 'number' then
        raise exception 'invalid_retrieval_embedding_vector' using errcode = '22023';
      end if;
    end loop;
    v_digest := encode(
      extensions.digest(convert_to(p_vector_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );
  else
    if coalesce(p_result_digest, '') !~ '^[a-f0-9]{64}$'
      or p_vector_payload is not null then
      raise exception 'output_embedding_vector_must_not_be_stored'
        using errcode = '23514';
    end if;
    v_digest := p_result_digest;
  end if;

  if v_call.status = 'succeeded' then
    if v_call.result_digest <> v_digest then
      raise exception 'scene_embedding_result_conflict' using errcode = '23505';
    end if;
    return query select true, true, v_call.result_digest;
    return;
  end if;
  if v_call.status <> 'prepared'
    or v_job.status <> 'generating'
    or v_job.active_attempt_id <> p_attempt_id
    or v_attempt.lease_token <> p_lease_token then
    raise exception 'scene_embedding_result_not_recordable' using errcode = '40001';
  end if;

  update public.generation_embedding_calls
  set status = 'succeeded',
      provider_request_id = nullif(p_provider_request_id, ''),
      result_digest = v_digest,
      vector_payload = p_vector_payload,
      input_units = coalesce(p_input_units, 0),
      output_units = coalesce(p_output_units, 0),
      cost_micros = coalesce(p_cost_micros, 0),
      billing_state = 'reported',
      provider_meta = coalesce(p_provider_meta, '{}'::jsonb),
      provider_completed_at = now(),
      updated_at = now()
  where id = p_embedding_call_id;

  return query select true, false, v_digest;
end;
$$;

create or replace function public.record_scene_embedding_failure(
  p_job_id uuid,
  p_profile_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_embedding_call_id uuid,
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
  v_call public.generation_embedding_calls%rowtype;
begin
  if p_outcome not in ('provider_rejected', 'provider_failed', 'indeterminate') then
    raise exception 'invalid_scene_embedding_failure' using errcode = '22023';
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
  from public.generation_embedding_calls c
  where c.id = p_embedding_call_id
    and c.job_id = p_job_id
    and c.attempt_id = p_attempt_id
    and c.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'scene_embedding_call_not_found' using errcode = 'P0002';
  end if;
  if v_call.status <> 'prepared' then return v_call.status; end if;

  update public.generation_embedding_calls
  set status = p_outcome,
      provider_request_id = nullif(p_provider_request_id, ''),
      billing_state = case when p_outcome = 'provider_rejected'
        then 'not_billable' else 'unknown' end,
      error_code = left(coalesce(p_error_code, p_outcome), 100),
      error_detail = left(coalesce(p_error_detail, ''), 1000),
      provider_completed_at = now(),
      updated_at = now()
  where id = p_embedding_call_id;

  return p_outcome;
end;
$$;

create or replace function public.get_scene_retrieval_embedding(
  p_job_id uuid,
  p_profile_id uuid,
  p_request_hash text
)
returns table (
  embedding_call_id uuid,
  vector_payload jsonb,
  result_digest text,
  provider_request_id text,
  input_units bigint,
  cost_micros bigint
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    c.id,
    c.vector_payload,
    c.result_digest,
    c.provider_request_id,
    c.input_units,
    c.cost_micros
  from public.generation_embedding_calls c
  where c.job_id = p_job_id
    and c.profile_id = p_profile_id
    and c.purpose = 'reference_retrieval_query'
    and c.candidate_index = 0
    and c.request_hash = p_request_hash
    and c.status = 'succeeded'
    and c.vector_payload is not null;
$$;

revoke all on function public.reserve_scene_embedding_call(
  uuid, uuid, uuid, uuid, uuid, text, integer, text
) from public, anon, authenticated;
revoke all on function public.record_scene_embedding_result(
  uuid, uuid, uuid, uuid, uuid, text, jsonb, text, bigint, bigint, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.record_scene_embedding_failure(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.get_scene_retrieval_embedding(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.reserve_scene_embedding_call(
  uuid, uuid, uuid, uuid, uuid, text, integer, text
) to service_role;
grant execute on function public.record_scene_embedding_result(
  uuid, uuid, uuid, uuid, uuid, text, jsonb, text, bigint, bigint, bigint, jsonb
) to service_role;
grant execute on function public.record_scene_embedding_failure(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.get_scene_retrieval_embedding(uuid, uuid, text)
  to service_role;
