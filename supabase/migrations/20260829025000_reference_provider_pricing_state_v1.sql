-- Fail-honest reference provider billing. Provider usage remains durable when
-- local pricing is unavailable, but an invented zero is never marked reported.

begin;

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
  v_provider_meta jsonb := coalesce(p_provider_meta, '{}'::jsonb);
  v_pricing_status text;
  v_billing_state text;
  v_effective_cost_micros bigint;
  v_provider_request_id text := nullif(p_provider_request_id, '');
  v_input_units bigint := coalesce(p_input_units, 0);
  v_output_units bigint := coalesce(p_output_units, 0);
begin
  if jsonb_typeof(p_response_payload) not in ('object', 'array')
    or octet_length(p_response_payload::text) > 1048576
    or jsonb_typeof(v_provider_meta) is distinct from 'object'
    or octet_length(v_provider_meta::text) > 65536
    or v_input_units < 0
    or v_output_units < 0
    or coalesce(p_cost_micros, 0) < 0 then
    raise exception 'invalid_provider_result' using errcode = '22023';
  end if;

  v_pricing_status := nullif(v_provider_meta ->> 'pricingStatus', '');
  if coalesce(v_pricing_status, '') not in ('priced', 'unpriced') then
    raise exception 'invalid_provider_pricing_status' using errcode = '22023';
  end if;
  if v_pricing_status = 'unpriced' then
    if coalesce(p_cost_micros, 0) <> 0 then
      raise exception 'unpriced_provider_result_has_cost'
        using errcode = '22023';
    end if;
    v_billing_state := 'unknown';
    v_effective_cost_micros := null;
  else
    v_billing_state := 'reported';
    v_effective_cost_micros := coalesce(p_cost_micros, 0);
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

  -- A lost successful response is replayable only with the identical ledger,
  -- including the priced/unpriced decision and provider metadata.
  if v_call.status = 'succeeded' then
    if v_call.response_hash <> v_response_hash
      or v_call.provider_request_id is distinct from v_provider_request_id
      or v_call.input_units is distinct from v_input_units
      or v_call.output_units is distinct from v_output_units
      or v_call.cost_micros is distinct from v_effective_cost_micros
      or v_call.billing_state is distinct from v_billing_state
      or v_call.provider_meta is distinct from v_provider_meta then
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
      provider_request_id = v_provider_request_id,
      response_payload = p_response_payload,
      response_hash = v_response_hash,
      input_units = v_input_units,
      output_units = v_output_units,
      cost_micros = v_effective_cost_micros,
      billing_state = v_billing_state,
      provider_meta = v_provider_meta,
      provider_completed_at = now(),
      updated_at = now()
  where id = p_call_id;

  update public.reference_index_runs
  set lease_expires_at = now() + interval '10 minutes', updated_at = now()
  where id = p_run_id;

  return query select true, false, v_response_hash;
end;
$$;

revoke all on function public.record_reference_index_provider_result(
  uuid, uuid, integer, uuid, uuid, jsonb, text,
  bigint, bigint, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.record_reference_index_provider_result(
  uuid, uuid, integer, uuid, uuid, jsonb, text,
  bigint, bigint, bigint, jsonb
) to service_role;

comment on function public.record_reference_index_provider_result(
  uuid, uuid, integer, uuid, uuid, jsonb, text,
  bigint, bigint, bigint, jsonb
) is
  'Stages a reference provider result; explicit unpriced metadata persists NULL cost and unknown billing.';

commit;
