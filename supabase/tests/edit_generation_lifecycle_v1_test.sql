-- Dependency-free, rollback-only acceptance coverage for edit generation.
-- Run after all local migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/edit_generation_lifecycle_v1_test.sql

begin;
set local statement_timeout = '30s';

create or replace function pg_temp.assert_edit_lifecycle(
  p_condition boolean,
  p_message text
)
returns void
language plpgsql
as $fn$
begin
  if p_condition is not true then
    raise exception 'edit_lifecycle_acceptance_failed: %', p_message;
  end if;
end
$fn$;

create or replace function pg_temp.edit_manifest(
  p_kind text,
  p_input_digit text
)
returns jsonb
language sql
as $fn$
  select jsonb_build_object(
    'schema', 'edit-request-v1',
    'provider', 'google-gemini',
    'modelRef', 'gemini-edit-acceptance',
    'promptVersion', 'edit-prompt-v1',
    'kind', p_kind,
    'photoId', 'local-photo-' || p_input_digit,
    'style', null,
    'inputSha256', repeat(p_input_digit, 64),
    'instructionSha256', repeat('f', 64),
    'hasMask', false,
    'maskSha256', null
  )
$fn$;

create or replace function pg_temp.edit_provider_result(
  p_profile_id uuid,
  p_job_id uuid,
  p_output_digit text,
  p_billing_state text,
  p_recovered boolean default false
)
returns jsonb
language sql
as $fn$
  select jsonb_build_object(
    'schema', 'edit-provider-result-v1',
    'providerRequestId', case
      when p_recovered then null else 'provider-response-1'
    end,
    'outputStorageBucket', 'edits',
    'outputStoragePath', public.edit_output_storage_path(
      p_profile_id, p_job_id, 'image/jpeg'
    ),
    'outputMimeType', 'image/jpeg',
    'outputByteSize', 2048,
    'outputSha256', repeat(p_output_digit, 64),
    'width', 1024,
    'height', 768,
    'inputUnits', 12,
    'outputUnits', 24,
    'costMicros', case
      when p_billing_state = 'reported' then 1500 else null
    end,
    'billingState', p_billing_state,
    'providerMeta', case
      when p_billing_state = 'reported' then jsonb_build_object(
        'pricingStatus', 'priced',
        'modelVersion', 'acceptance'
      )
      else jsonb_build_object(
        'pricingStatus', 'unpriced',
        'recoveredFromDeterministicStorage', p_recovered
      )
    end
  )
$fn$;

do $test$
declare
  v_profile constant uuid := 'e1000000-0000-4000-8100-000000000001';
  v_other_profile constant uuid :=
    'e1000000-0000-4000-8100-000000000002';
  v_lease_a constant uuid := 'e2000000-0000-4000-8200-000000000001';
  v_lease_b constant uuid := 'e2000000-0000-4000-8200-000000000002';
  v_lease_c constant uuid := 'e2000000-0000-4000-8200-000000000003';
  v_lease_d constant uuid := 'e2000000-0000-4000-8200-000000000004';
  v_call_a constant uuid := 'e3000000-0000-4000-8300-000000000001';
  v_call_b constant uuid := 'e3000000-0000-4000-8300-000000000002';
  v_call_c constant uuid := 'e3000000-0000-4000-8300-000000000003';
  v_job_a uuid;
  v_job_b uuid;
  v_job_c uuid;
  v_job_d uuid;
  v_replay_job uuid;
  v_taste_event uuid;
  v_request_hash text;
  v_status text;
  v_quota text;
  v_call_status text;
  v_result_hash text;
  v_lease_token uuid;
  v_lease_expires_at timestamptz;
  v_bool boolean;
  v_replayed boolean;
  v_attempt integer;
  v_count integer;
  v_failed boolean;
begin
  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
  ) values
  (
    '00000000-0000-0000-0000-000000000000',
    v_profile,
    'authenticated',
    'authenticated',
    'edit-lifecycle-owner@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Edit lifecycle owner"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    v_other_profile,
    'authenticated',
    'authenticated',
    'edit-lifecycle-other@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Edit lifecycle other"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

  update public.profiles set plan = 'free' where id = v_profile;
  update public.edit_generation_policy
  set free_monthly_limit = 3,
      reservation_ttl_seconds = 900,
      lease_seconds = 600,
      retry_grace_seconds = 300,
      indeterminate_release_seconds = 3600,
      updated_at = now()
  where policy_key = 'default';

  -- Reservation, idempotent replay, conflict, and finite-cap accounting.
  select job_id, job_status, request_hash, quota_state
  into v_job_a, v_status, v_request_hash, v_quota
  from public.reserve_edit_generation(
    v_profile,
    'edit-acceptance-a',
    pg_temp.edit_manifest('describe', '1')
  );
  perform pg_temp.assert_edit_lifecycle(
    v_status = 'reserved' and v_quota = 'held',
    'first reservation did not create a held reserved job'
  );

  select job_id, replayed
  into v_replay_job, v_replayed
  from public.reserve_edit_generation(
    v_profile,
    'edit-acceptance-a',
    pg_temp.edit_manifest('describe', '1')
  );
  perform pg_temp.assert_edit_lifecycle(
    v_replay_job = v_job_a and v_replayed,
    'same idempotency key and manifest did not replay the original job'
  );
  select count(*)::integer into v_count
  from public.edit_generation_jobs
  where profile_id = v_profile and idempotency_key = 'edit-acceptance-a';
  perform pg_temp.assert_edit_lifecycle(
    v_count = 1,
    'reservation replay created a duplicate job'
  );

  v_failed := false;
  begin
    perform public.reserve_edit_generation(
      v_profile,
      'edit-acceptance-a',
      pg_temp.edit_manifest('reroll', '9')
    );
  exception when unique_violation then
    v_failed := sqlerrm = 'edit_generation_idempotency_conflict';
  end;
  perform pg_temp.assert_edit_lifecycle(
    v_failed,
    'same idempotency key accepted conflicting request evidence'
  );

  select job_id into v_job_b
  from public.reserve_edit_generation(
    v_profile,
    'edit-acceptance-b',
    pg_temp.edit_manifest('style_match', '2')
  );
  select job_id into v_job_c
  from public.reserve_edit_generation(
    v_profile,
    'edit-acceptance-c',
    pg_temp.edit_manifest('template', '3')
  );
  select count(*)::integer into v_count
  from public.edit_quota_reservations
  where profile_id = v_profile and state = 'held';
  perform pg_temp.assert_edit_lifecycle(
    v_count = 3,
    'multiple held jobs did not jointly consume the finite cap'
  );
  select job_id, replayed into v_replay_job, v_replayed
  from public.reserve_edit_generation(
    v_profile,
    'edit-acceptance-a',
    pg_temp.edit_manifest('describe', '1')
  );
  perform pg_temp.assert_edit_lifecycle(
    v_replay_job = v_job_a and v_replayed,
    'idempotent replay was incorrectly rejected after the cap filled'
  );
  v_failed := false;
  begin
    perform public.reserve_edit_generation(
      v_profile,
      'edit-acceptance-over-cap',
      pg_temp.edit_manifest('describe', '4')
    );
  exception when sqlstate 'P0001' then
    v_failed := sqlerrm = 'edit_quota_exhausted';
  end;
  perform pg_temp.assert_edit_lifecycle(
    v_failed,
    'held reservations allowed quota oversubscription'
  );

  -- Claim replay preserves the attempt and caller-generated lease token.
  select claimed, replayed, job_status, attempt_number, lease_token,
    lease_expires_at
  into v_bool, v_replayed, v_status, v_attempt, v_lease_token,
    v_lease_expires_at
  from public.claim_edit_generation(v_job_a, v_profile, v_lease_a);
  perform pg_temp.assert_edit_lifecycle(
    v_bool and not v_replayed and v_status = 'processing'
      and v_attempt = 1 and v_lease_token = v_lease_a
      and v_lease_expires_at > now(),
    'initial edit claim did not establish attempt one and its lease'
  );
  select claimed, replayed, attempt_number, lease_token
  into v_bool, v_replayed, v_attempt, v_lease_token
  from public.claim_edit_generation(v_job_a, v_profile, v_lease_a);
  perform pg_temp.assert_edit_lifecycle(
    v_bool and v_replayed and v_attempt = 1 and v_lease_token = v_lease_a,
    'same claim token was not replayed without incrementing the attempt'
  );

  -- Durable provider preparation is the sole one-shot HTTP authorization.
  select invoke_allowed, call_status, job_status
  into v_bool, v_call_status, v_status
  from public.begin_edit_provider_call(
    v_job_a, v_profile, 1, v_lease_a, v_call_a, v_request_hash
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and v_call_status = 'prepared' and v_status = 'provider_prepared',
    'initial provider preparation did not authorize exactly one call'
  );
  select invoke_allowed, call_status
  into v_bool, v_call_status
  from public.begin_edit_provider_call(
    v_job_a, v_profile, 1, v_lease_a, v_call_a, v_request_hash
  );
  perform pg_temp.assert_edit_lifecycle(
    not v_bool and v_call_status = 'prepared',
    'provider preparation replay authorized duplicate HTTP'
  );
  select count(*)::integer into v_count
  from public.edit_provider_calls where job_id = v_job_a;
  perform pg_temp.assert_edit_lifecycle(
    v_count = 1,
    'provider preparation replay created a duplicate call row'
  );

  -- Result capture is gated by the exact deterministic storage object.
  v_failed := false;
  begin
    perform public.record_edit_provider_result(
      v_job_a,
      v_profile,
      1,
      v_lease_a,
      v_call_a,
      pg_temp.edit_provider_result(
        v_profile, v_job_a, 'a', 'reported', false
      )
    );
  exception when sqlstate 'P0002' then
    v_failed := sqlerrm = 'edit_output_object_missing';
  end;
  perform pg_temp.assert_edit_lifecycle(
    v_failed,
    'provider result captured before deterministic object persistence'
  );
  insert into storage.objects (bucket_id, name)
  values (
    'edits',
    public.edit_output_storage_path(v_profile, v_job_a, 'image/jpeg')
  );
  select captured, replayed, job_status, result_hash
  into v_bool, v_replayed, v_status, v_result_hash
  from public.record_edit_provider_result(
    v_job_a,
    v_profile,
    1,
    v_lease_a,
    v_call_a,
    pg_temp.edit_provider_result(
      v_profile, v_job_a, 'a', 'reported', false
    )
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and not v_replayed and v_status = 'result_captured'
      and v_result_hash ~ '^[a-f0-9]{64}$',
    'deterministic object did not permit provider result capture'
  );
  select captured, replayed into v_bool, v_replayed
  from public.record_edit_provider_result(
    v_job_a,
    v_profile,
    1,
    v_lease_a,
    v_call_a,
    pg_temp.edit_provider_result(
      v_profile, v_job_a, 'a', 'reported', false
    )
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and v_replayed,
    'same provider result evidence was not idempotently replayable'
  );

  -- Delivery inserts one event and charges one reservation transactionally.
  select delivered, replayed, job_status, quota_state, taste_event_id
  into v_bool, v_replayed, v_status, v_quota, v_taste_event
  from public.settle_edit_generation(
    v_job_a,
    v_profile,
    public.edit_output_storage_path(v_profile, v_job_a, 'image/jpeg'),
    repeat('a', 64)
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and not v_replayed and v_status = 'delivered'
      and v_quota = 'charged' and v_taste_event is not null,
    'captured result did not atomically deliver and charge'
  );
  select count(*)::integer into v_count
  from public.taste_events
  where profile_id = v_profile
    and event_type = 'edit_generated'
    and subject ->> 'editJobId' = v_job_a::text;
  perform pg_temp.assert_edit_lifecycle(
    v_count = 1,
    'settlement did not create exactly one edit taste event'
  );
  select delivered, replayed, taste_event_id
  into v_bool, v_replayed, v_replay_job
  from public.settle_edit_generation(
    v_job_a,
    v_profile,
    public.edit_output_storage_path(v_profile, v_job_a, 'image/jpeg'),
    repeat('a', 64)
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and v_replayed and v_replay_job = v_taste_event,
    'settlement replay did not return the original delivery evidence'
  );
  select count(*)::integer into v_count
  from public.taste_events
  where subject ->> 'editJobId' = v_job_a::text;
  perform pg_temp.assert_edit_lifecycle(
    v_count = 1,
    'settlement replay duplicated the taste event'
  );

  -- Definitive provider rejection releases its reservation.
  select request_hash into v_request_hash
  from public.edit_generation_jobs where id = v_job_b;
  perform public.claim_edit_generation(v_job_b, v_profile, v_lease_b);
  perform public.begin_edit_provider_call(
    v_job_b, v_profile, 1, v_lease_b, v_call_b, v_request_hash
  );
  select recorded, replayed, job_status, call_status, quota_state
  into v_bool, v_replayed, v_status, v_call_status, v_quota
  from public.record_edit_provider_failure(
    v_job_b,
    v_profile,
    1,
    v_lease_b,
    v_call_b,
    'rejected',
    'provider_rejected_input',
    'provider rejected the request',
    'provider-rejection-1'
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and not v_replayed and v_status = 'failed'
      and v_call_status = 'rejected' and v_quota = 'released',
    'definitive provider rejection did not fail and release'
  );
  perform pg_temp.assert_edit_lifecycle(
    (select billing_state = 'not_billable' and cost_micros is null
      from public.edit_provider_calls where id = v_call_b),
    'definitive rejection did not persist non-billable evidence'
  );
  select recorded, replayed into v_bool, v_replayed
  from public.record_edit_provider_failure(
    v_job_b,
    v_profile,
    1,
    v_lease_b,
    v_call_b,
    'rejected',
    'provider_rejected_input',
    'provider rejected the request',
    'provider-rejection-1'
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and v_replayed,
    'definitive failure evidence was not idempotently replayable'
  );

  -- Released quota permits one replacement reservation; charged plus held
  -- still count together toward the finite cap.
  select job_id into v_job_d
  from public.reserve_edit_generation(
    v_profile,
    'edit-acceptance-d',
    pg_temp.edit_manifest('describe', '4')
  );
  select count(*)::integer into v_count
  from public.edit_quota_reservations
  where profile_id = v_profile and state in ('held', 'charged');
  perform pg_temp.assert_edit_lifecycle(
    v_count = 3,
    'charged and held quota states did not jointly enforce the cap'
  );

  -- Indeterminate provider work holds quota until exact-object recovery.
  select request_hash into v_request_hash
  from public.edit_generation_jobs where id = v_job_c;
  perform public.claim_edit_generation(v_job_c, v_profile, v_lease_c);
  perform public.begin_edit_provider_call(
    v_job_c, v_profile, 1, v_lease_c, v_call_c, v_request_hash
  );
  select recorded, job_status, call_status, quota_state
  into v_bool, v_status, v_call_status, v_quota
  from public.record_edit_provider_failure(
    v_job_c,
    v_profile,
    1,
    v_lease_c,
    v_call_c,
    'indeterminate',
    'provider_connection_lost',
    'connection closed after request dispatch',
    null
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and v_status = 'indeterminate'
      and v_call_status = 'indeterminate' and v_quota = 'held',
    'ambiguous provider outcome did not remain held and indeterminate'
  );
  perform pg_temp.assert_edit_lifecycle(
    (select billing_state = 'unknown' and cost_micros is null
      from public.edit_provider_calls where id = v_call_c),
    'indeterminate provider outcome stored a fake known cost'
  );
  insert into storage.objects (bucket_id, name)
  values (
    'edits',
    public.edit_output_storage_path(v_profile, v_job_c, 'image/jpeg')
  );
  select captured, replayed, job_status
  into v_bool, v_replayed, v_status
  from public.recover_edit_provider_result(
    v_job_c,
    v_profile,
    v_call_c,
    pg_temp.edit_provider_result(
      v_profile, v_job_c, 'c', 'unknown', true
    )
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and not v_replayed and v_status = 'result_captured',
    'deterministic object did not recover indeterminate provider work'
  );
  perform pg_temp.assert_edit_lifecycle(
    (select status = 'succeeded' and billing_state = 'unknown'
        and cost_micros is null
      from public.edit_provider_calls where id = v_call_c),
    'recovery did not seal the call with unknown billing'
  );
  select delivered, replayed, quota_state
  into v_bool, v_replayed, v_quota
  from public.settle_edit_generation(
    v_job_c,
    v_profile,
    public.edit_output_storage_path(v_profile, v_job_c, 'image/jpeg'),
    repeat('c', 64)
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and not v_replayed and v_quota = 'charged',
    'recovered output did not settle and charge exactly once'
  );

  -- A definite pre-provider failure releases the replacement hold and replays.
  perform public.claim_edit_generation(v_job_d, v_profile, v_lease_d);
  select failed, replayed, job_status, quota_state
  into v_bool, v_replayed, v_status, v_quota
  from public.fail_edit_generation_pre_provider(
    v_job_d,
    v_profile,
    1,
    v_lease_d,
    'local_validation_failed',
    'synthetic pre-provider failure'
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and not v_replayed and v_status = 'failed'
      and v_quota = 'released',
    'pre-provider failure did not fail and release'
  );
  select failed, replayed into v_bool, v_replayed
  from public.fail_edit_generation_pre_provider(
    v_job_d,
    v_profile,
    1,
    v_lease_d,
    'local_validation_failed',
    'synthetic pre-provider failure'
  );
  perform pg_temp.assert_edit_lifecycle(
    v_bool and v_replayed,
    'same pre-provider failure evidence was not replayable'
  );

  -- Direct table access is owner-read only; mutations and all lifecycle RPCs
  -- remain service-role operations.
  perform pg_temp.assert_edit_lifecycle(
    has_table_privilege(
      'authenticated', 'public.edit_generation_jobs', 'SELECT'
    ),
    'authenticated role lacks owner-filtered job SELECT'
  );
  perform pg_temp.assert_edit_lifecycle(
    not has_table_privilege(
      'authenticated', 'public.edit_generation_jobs', 'INSERT'
    )
      and not has_table_privilege(
        'authenticated', 'public.edit_generation_jobs', 'UPDATE'
      )
      and not has_table_privilege(
        'authenticated', 'public.edit_generation_jobs', 'DELETE'
      ),
    'authenticated role has direct edit-job mutation privilege'
  );
  perform pg_temp.assert_edit_lifecycle(
    not has_table_privilege(
      'authenticated', 'public.edit_provider_calls', 'SELECT'
    ),
    'authenticated role can directly read provider-call evidence'
  );
  perform pg_temp.assert_edit_lifecycle(
    not has_function_privilege(
      'authenticated',
      'public.reserve_edit_generation(uuid,text,jsonb)',
      'EXECUTE'
    ),
    'authenticated role can invoke edit reservation RPC'
  );
  perform pg_temp.assert_edit_lifecycle(
    has_function_privilege(
      'service_role',
      'public.reserve_edit_generation(uuid,text,jsonb)',
      'EXECUTE'
    ),
    'service role cannot invoke edit reservation RPC'
  );
  perform pg_temp.assert_edit_lifecycle(
    has_function_privilege(
      'service_role',
      'public.settle_edit_generation(uuid,uuid,text,text)',
      'EXECUTE'
    ),
    'service role cannot invoke edit settlement RPC'
  );
end
$test$;

-- Exercise owner RLS under the real authenticated role rather than merely
-- checking catalog policy definitions.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'e1000000-0000-4000-8100-000000000001',
  true
);
-- Division by zero makes an RLS mismatch fail under ON_ERROR_STOP without
-- requiring authenticated to execute a test-only helper function.
select 1 / ((select count(*) = 4 from public.edit_generation_jobs)::integer)
  as owner_rls_exposes_own_jobs;
select set_config(
  'request.jwt.claim.sub',
  'e1000000-0000-4000-8100-000000000002',
  true
);
select 1 / ((select count(*) = 0 from public.edit_generation_jobs)::integer)
  as owner_rls_hides_other_jobs;
reset role;

rollback;
