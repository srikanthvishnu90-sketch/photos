-- pgTAP acceptance coverage for 20260829023000_reference_index_atomic_lifecycle_v1.sql.
-- Run with `supabase test db` after applying local migrations.

begin;

create extension if not exists pgtap;
select plan(47);

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
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-a111-111111111111',
  'authenticated',
  'authenticated',
  'reference-index-lifecycle@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Reference lifecycle test"}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
);

create or replace function pg_temp.reference_manifest(
  p_asset_id uuid,
  p_content_hash text,
  p_conditioning_hash text
)
returns jsonb
language sql
as $fn$
  select jsonb_build_object(
    'schema', 'reference-index-request-v1',
    'requestMode', 'asset_ids',
    'requestedAssetIds', jsonb_build_array(p_asset_id::text),
    'embeddingModel', 'gemini-embedding-2',
    'visionModel', 'gemini-2.5-flash',
    'visionPromptVersion', 'reference-vision-look-v1',
    'retrievalDocumentVersion', 'reference-retrieval-document-v1',
    'rightsPolicyVersion', 'conditioning-rights-v1',
    'assets', jsonb_build_array(jsonb_build_object(
      'assetId', p_asset_id::text,
      'ownerProfileId', '11111111-1111-4111-a111-111111111111',
      'source', 'user_upload',
      'stylePackId', null,
      'rights', 'owned',
      'usableForConditioning', true,
      'storagePath',
        '11111111-1111-4111-a111-111111111111/source/' ||
          p_asset_id::text || '.jpg',
      'contentSha256', p_content_hash,
      'conditioningSha256', p_conditioning_hash,
      'conditioningStorageBucket', 'inspiration-conditioning',
      'conditioningStoragePath',
        '11111111-1111-4111-a111-111111111111/reference/' ||
          p_asset_id::text || '/' || p_conditioning_hash || '.jpg',
      'mimeType', 'image/jpeg',
      'byteSize', 1024
    ))
  )
$fn$;

insert into public.inspiration_assets (
  id,
  profile_id,
  storage_path,
  label,
  mime_type,
  byte_size,
  source,
  rights,
  usable_for_conditioning
)
select
  asset_id,
  '11111111-1111-4111-a111-111111111111'::uuid,
  '11111111-1111-4111-a111-111111111111/source/' ||
    asset_id::text || '.jpg',
  'fixture',
  'image/jpeg',
  2048,
  'user_upload',
  case when asset_id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa7'::uuid
    then 'unverified' else 'owned' end,
  asset_id <> 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa7'::uuid
from unnest(array[
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1'::uuid,
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2'::uuid,
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3'::uuid,
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4'::uuid,
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa5'::uuid,
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa6'::uuid,
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa7'::uuid
]) asset_id;

create temp table run_one as
select * from public.reserve_reference_index_run(
  '11111111-1111-4111-a111-111111111111',
  'acceptance-run-one',
  pg_temp.reference_manifest(
    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', repeat('1', 64), repeat('a', 64)
  ),
  'reference-index-v1'
);

select is((select run_status from run_one), 'reserved',
  'reservation creates a reserved run');
select is((select replayed from run_one), false,
  'first reservation is not a replay');
select is((select index_status from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1'), 'indexing',
  'reservation claims the asset');
select is((select reference_index_run_id::text from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1'),
  (select run_id::text from run_one), 'asset is bound to its run');
select is((select count(*)::integer from public.reference_index_run_items
  where run_id = (select run_id from run_one)), 1,
  'reservation records one immutable run item');

create temp table run_one_replay as
select * from public.reserve_reference_index_run(
  '11111111-1111-4111-a111-111111111111',
  'acceptance-run-one',
  pg_temp.reference_manifest(
    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', repeat('1', 64), repeat('a', 64)
  ),
  'reference-index-v1'
);
select is((select run_id::text from run_one_replay),
  (select run_id::text from run_one), 'same idempotency key returns same run');
select is((select replayed from run_one_replay), true,
  'same reservation is identified as replay');

select throws_ok(
  $$select * from public.reserve_reference_index_run(
    '11111111-1111-4111-a111-111111111111',
    'acceptance-run-one-competing',
    pg_temp.reference_manifest(
      'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', repeat('1', 64), repeat('a', 64)
    ),
    'reference-index-v1'
  )$$,
  '40001', 'reference_asset_already_claimed',
  'a bound asset cannot be claimed by another run'
);
select is((select count(*)::integer from public.reference_index_runs
  where idempotency_key = 'acceptance-run-one-competing'), 0,
  'failed competing claim leaves no run row');

create temp table claim_one as
select * from public.claim_reference_index_run(
  (select run_id from run_one),
  '11111111-1111-4111-a111-111111111111',
  600
);
select is((select claimed from claim_one), true, 'reserved run is leased');
select is((select run_status from claim_one), 'processing',
  'leased run enters processing');

update public.inspiration_assets
set rights = 'unverified', usable_for_conditioning = false
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
select throws_ok(
  $$select * from public.begin_reference_index_provider_call(
    (select run_id from run_one),
    '11111111-1111-4111-a111-111111111111',
    (select attempt_number from claim_one),
    (select lease_token from claim_one),
    'cccccccc-cccc-4ccc-accc-ccccccccccc1',
    'vision', 0, 'gemini-2.5-flash', repeat('9', 64)
  )$$,
  '23514', 'reference_rights_or_hash_revalidation_failed',
  'provider-call reservation rejects revoked rights transactionally'
);
select is((select count(*)::integer from public.reference_index_provider_calls
  where run_id = (select run_id from run_one)), 0,
  'failed rights revalidation creates no provider-call row');

update public.inspiration_assets
set rights = 'owned', usable_for_conditioning = true,
    conditioning_sha256 = repeat('f', 64)
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
select throws_ok(
  $$select * from public.begin_reference_index_provider_call(
    (select run_id from run_one),
    '11111111-1111-4111-a111-111111111111',
    (select attempt_number from claim_one),
    (select lease_token from claim_one),
    'cccccccc-cccc-4ccc-accc-ccccccccccc1',
    'vision', 0, 'gemini-2.5-flash', repeat('9', 64)
  )$$,
  '23514', 'reference_rights_or_hash_revalidation_failed',
  'provider-call reservation rejects hash drift transactionally'
);
select is((select count(*)::integer from public.reference_index_provider_calls
  where run_id = (select run_id from run_one)), 0,
  'failed hash revalidation creates no provider-call row');

update public.inspiration_assets set conditioning_sha256 = repeat('a', 64)
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
create temp table call_one as
select * from public.begin_reference_index_provider_call(
  (select run_id from run_one),
  '11111111-1111-4111-a111-111111111111',
  (select attempt_number from claim_one),
  (select lease_token from claim_one),
  'cccccccc-cccc-4ccc-accc-ccccccccccc1',
  'vision', 0, 'gemini-2.5-flash', repeat('9', 64)
);
select is((select invoke_allowed from call_one), true,
  'valid call reservation permits exactly one provider invocation');
select is((select call_status from call_one), 'prepared',
  'provider call is durable before HTTP');

select is(public.record_reference_index_provider_failure(
  (select run_id from run_one),
  '11111111-1111-4111-a111-111111111111',
  (select attempt_number from claim_one),
  (select lease_token from claim_one),
  'cccccccc-cccc-4ccc-accc-ccccccccccc1',
  'rejected', 'provider_rejected', 'fixture rejection', null
), 'rejected', 'provider failure is recorded');
select is(public.record_reference_index_provider_failure(
  (select run_id from run_one),
  '11111111-1111-4111-a111-111111111111',
  (select attempt_number from claim_one),
  (select lease_token from claim_one),
  'cccccccc-cccc-4ccc-accc-ccccccccccc1',
  'rejected', 'provider_rejected', 'fixture rejection', null
), 'rejected', 'identical terminal provider failure replays after lease clear');
select is((select status from public.reference_index_runs
  where id = (select run_id from run_one)), 'failed',
  'provider rejection terminalizes the run');
select is((select index_status from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1'), 'failed',
  'provider rejection releases the asset as failed');
select throws_ok(
  $$select public.record_reference_index_provider_failure(
    (select run_id from run_one),
    '11111111-1111-4111-a111-111111111111',
    (select attempt_number from claim_one),
    (select lease_token from claim_one),
    'cccccccc-cccc-4ccc-accc-ccccccccccc1',
    'rejected', 'provider_rejected', 'different detail', null
  )$$,
  '23505', 'reference_provider_failure_conflict',
  'conflicting terminal provider failure is rejected'
);

create temp table run_two as
select * from public.reserve_reference_index_run(
  '11111111-1111-4111-a111-111111111111', 'acceptance-run-two',
  pg_temp.reference_manifest(
    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2', repeat('2', 64), repeat('b', 64)
  ), 'reference-index-v1'
);
create temp table claim_two as
select * from public.claim_reference_index_run(
  (select run_id from run_two), '11111111-1111-4111-a111-111111111111', 600
);
create temp table failed_two as
select * from public.fail_reference_index_run(
  (select run_id from run_two), '11111111-1111-4111-a111-111111111111',
  (select attempt_number from claim_two), (select lease_token from claim_two),
  'local_precondition_failed', 'fixture local failure'
);
select is((select failed from failed_two), true,
  'pre-provider failure terminalizes the active attempt');
select is((select replayed from failed_two), false,
  'first pre-provider failure is not a replay');
select is((select status from public.reference_index_runs
  where id = (select run_id from run_two)), 'failed',
  'pre-provider failure persists terminal run state');
select is((select reference_index_run_id from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2'), null,
  'pre-provider failure releases the asset binding');
select is((select replayed from public.fail_reference_index_run(
  (select run_id from run_two), '11111111-1111-4111-a111-111111111111',
  (select attempt_number from claim_two), (select lease_token from claim_two),
  'local_precondition_failed', 'fixture local failure'
)), true, 'identical pre-provider failure is replayable after lease clear');
select throws_ok(
  $$select * from public.fail_reference_index_run(
    (select run_id from run_two),
    '11111111-1111-4111-a111-111111111111',
    (select attempt_number from claim_two) + 1,
    (select lease_token from claim_two),
    'local_precondition_failed', 'fixture local failure'
  )$$,
  '23505', 'reference_failure_conflict',
  'pre-provider replay is tied to its original attempt'
);

update public.inspiration_assets set index_status = 'indexing'
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3';
select ok((select reference_index_claim_expires_at is not null
  from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3'),
  'legacy direct claim receives a provisional expiry');
update public.inspiration_assets
set reference_index_claim_expires_at = now() - interval '1 second'
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3';
create temp table reaped_asset as
select * from public.reap_stale_reference_index_work(1, 900);
select is((select resulting_status from reaped_asset), 'failed',
  'reaper fails an expired provisional claim');
select is((select index_status from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3'), 'failed',
  'expired provisional asset is retryable from failed state');

create temp table run_four as
select * from public.reserve_reference_index_run(
  '11111111-1111-4111-a111-111111111111', 'acceptance-run-four',
  pg_temp.reference_manifest(
    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4', repeat('4', 64), repeat('d', 64)
  ), 'reference-index-v1'
);
create temp table claim_four as
select * from public.claim_reference_index_run(
  (select run_id from run_four), '11111111-1111-4111-a111-111111111111', 600
);
update public.reference_index_runs set lease_expires_at = now() - interval '1 second'
where id = (select run_id from run_four);
create temp table reaped_four as
select * from public.reap_stale_reference_index_work(1, 900);
select is((select resulting_status from reaped_four), 'reserved',
  'expired lease without a prepared call is requeued');
select is((select status from public.reference_index_runs
  where id = (select run_id from run_four)), 'reserved',
  'retry-safe expired run is reserved without a lease');
select is((select reference_index_run_id::text from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4'),
  (select run_id::text from run_four),
  'retry-safe requeue retains the atomic asset binding');

create temp table run_five as
select * from public.reserve_reference_index_run(
  '11111111-1111-4111-a111-111111111111', 'acceptance-run-five',
  pg_temp.reference_manifest(
    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa5', repeat('5', 64), repeat('e', 64)
  ), 'reference-index-v1'
);
create temp table claim_five as
select * from public.claim_reference_index_run(
  (select run_id from run_five), '11111111-1111-4111-a111-111111111111', 600
);
select * from public.begin_reference_index_provider_call(
  (select run_id from run_five),
  '11111111-1111-4111-a111-111111111111',
  (select attempt_number from claim_five), (select lease_token from claim_five),
  'cccccccc-cccc-4ccc-accc-ccccccccccc5',
  'vision', 0, 'gemini-2.5-flash', repeat('8', 64)
);
update public.reference_index_runs set lease_expires_at = now() - interval '1 second'
where id = (select run_id from run_five);
create temp table reaped_five as
select * from public.reap_stale_reference_index_work(1, 900);
select is((select resulting_status from reaped_five), 'indeterminate',
  'expired lease after prepared provider call is never retried');
select is((select status from public.reference_index_provider_calls
  where run_id = (select run_id from run_five)), 'indeterminate',
  'ambiguous prepared call becomes indeterminate');
select is((select billing_state from public.reference_index_provider_calls
  where run_id = (select run_id from run_five)), 'unknown',
  'ambiguous provider call preserves unknown billing');
select is((select status from public.reference_index_runs
  where id = (select run_id from run_five)), 'indeterminate',
  'ambiguous provider outcome terminalizes the run');
select is((select reference_index_run_id from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa5'), null,
  'ambiguous provider outcome releases its asset binding');

create temp table manifest_six as
select jsonb_set(
  jsonb_set(
    pg_temp.reference_manifest(
      'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa6', repeat('6', 64), repeat('6', 64)
    ),
    '{requestedAssetIds}',
    jsonb_build_array(
      'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa6',
      'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa7'
    )
  ),
  '{assets}',
  (pg_temp.reference_manifest(
    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa6', repeat('6', 64), repeat('6', 64)
  ) -> 'assets') || (pg_temp.reference_manifest(
    'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa7', repeat('7', 64), repeat('7', 64)
  ) -> 'assets')
) as body;
select throws_ok(
  $$select * from public.reserve_reference_index_run(
    '11111111-1111-4111-a111-111111111111',
    'acceptance-atomic-rollback',
    (select body from manifest_six),
    'reference-index-v1'
  )$$,
  '42501', 'reference_asset_rights_or_owner_mismatch',
  'one invalid asset rolls back the entire multi-asset reservation'
);
select is((select index_status from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa6'), 'pending',
  'partial reservation cannot strand an earlier valid asset');
select is((select count(*)::integer from public.reference_index_runs
  where idempotency_key = 'acceptance-atomic-rollback'), 0,
  'partial reservation rollback leaves no run row');

select ok(not has_function_privilege(
  'authenticated',
  'public.reserve_reference_index_run(uuid,text,jsonb,text)', 'EXECUTE'
), 'authenticated cannot reserve durable reference runs');
select ok(not has_function_privilege(
  'authenticated',
  'public.begin_reference_index_provider_call(uuid,uuid,integer,uuid,uuid,text,integer,text,text)',
  'EXECUTE'
), 'authenticated cannot reserve provider calls');
select ok(not has_function_privilege(
  'authenticated',
  'public.fail_reference_index_run(uuid,uuid,integer,uuid,text,text)', 'EXECUTE'
), 'authenticated cannot fail reference runs');
select ok(not has_function_privilege(
  'authenticated',
  'public.reap_stale_reference_index_work(integer,integer)', 'EXECUTE'
), 'authenticated cannot invoke the reaper');
select ok(has_function_privilege(
  'service_role',
  'public.reap_stale_reference_index_work(integer,integer)', 'EXECUTE'
), 'service role can invoke the reaper');

select * from finish();
rollback;
