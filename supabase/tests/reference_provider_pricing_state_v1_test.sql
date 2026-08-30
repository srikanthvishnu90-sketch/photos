-- pgTAP acceptance coverage for fail-honest reference provider pricing.
-- Run with `supabase test db` after applying local migrations.

begin;
create extension if not exists pgtap;
select plan(17);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '33333333-3333-4333-a333-333333333333',
  'authenticated', 'authenticated', 'pricing-owner@example.invalid', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Pricing owner"}'::jsonb, now(), now(), '', '', '', ''
);

create or replace function pg_temp.pricing_manifest(
  p_asset_id uuid,
  p_hash text
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
      'ownerProfileId', '33333333-3333-4333-a333-333333333333',
      'source', 'user_upload',
      'stylePackId', null,
      'rights', 'owned',
      'usableForConditioning', true,
      'storagePath',
        '33333333-3333-4333-a333-333333333333/source/' ||
          p_asset_id::text || '.jpg',
      'contentSha256', p_hash,
      'conditioningSha256', p_hash,
      'conditioningStorageBucket', 'inspiration-conditioning',
      'conditioningStoragePath',
        '33333333-3333-4333-a333-333333333333/reference/' ||
          p_asset_id::text || '/' || p_hash || '.jpg',
      'mimeType', 'image/jpeg',
      'byteSize', 1024
    ))
  )
$fn$;

insert into public.inspiration_assets (
  id, profile_id, storage_path, label, mime_type, byte_size, source, rights,
  usable_for_conditioning
) values
(
  'dddddddd-dddd-4ddd-addd-ddddddddddd1',
  '33333333-3333-4333-a333-333333333333',
  '33333333-3333-4333-a333-333333333333/source/dddddddd-dddd-4ddd-addd-ddddddddddd1.jpg',
  'unpriced fixture', 'image/jpeg', 1024, 'user_upload', 'owned', true
),
(
  'dddddddd-dddd-4ddd-addd-ddddddddddd2',
  '33333333-3333-4333-a333-333333333333',
  '33333333-3333-4333-a333-333333333333/source/dddddddd-dddd-4ddd-addd-ddddddddddd2.jpg',
  'priced fixture', 'image/jpeg', 1024, 'user_upload', 'owned', true
);

create temp table unpriced_run as
select * from public.reserve_reference_index_run(
  '33333333-3333-4333-a333-333333333333',
  'pricing-unpriced-run',
  pg_temp.pricing_manifest(
    'dddddddd-dddd-4ddd-addd-ddddddddddd1', repeat('a', 64)
  ),
  'reference-index-v1'
);
create temp table unpriced_claim as
select * from public.claim_reference_index_run(
  (select run_id from unpriced_run),
  '33333333-3333-4333-a333-333333333333', 600
);
select * from public.begin_reference_index_provider_call(
  (select run_id from unpriced_run),
  '33333333-3333-4333-a333-333333333333',
  (select attempt_number from unpriced_claim),
  (select lease_token from unpriced_claim),
  'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1',
  'vision', 0, 'gemini-2.5-flash', repeat('1', 64)
);

create temp table unpriced_result as
select * from public.record_reference_index_provider_result(
  (select run_id from unpriced_run),
  '33333333-3333-4333-a333-333333333333',
  (select attempt_number from unpriced_claim),
  (select lease_token from unpriced_claim),
  'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1',
  '{"schema":"reference-vision-result-v1","rows":[]}'::jsonb,
  'provider-unpriced-1', 123, 45, 0,
  '{"pricingStatus":"unpriced","pricingVersion":null,"unpricedReason":"rate_config_missing_or_invalid"}'::jsonb
);
select is((select staged from unpriced_result), true,
  'unpriced provider result is staged');
select is((select replayed from unpriced_result), false,
  'first unpriced result is not a replay');
select is((select billing_state from public.reference_index_provider_calls
  where id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1'), 'unknown',
  'explicit unpriced metadata derives unknown billing');
select is((select cost_micros from public.reference_index_provider_calls
  where id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1'), null,
  'unpriced provider result stores NULL cost');
select is((select input_units from public.reference_index_provider_calls
  where id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1'), 123::bigint,
  'unpriced result still preserves usage');
select is((select provider_meta ->> 'pricingStatus'
  from public.reference_index_provider_calls
  where id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1'), 'unpriced',
  'unpriced state remains explicit in provider metadata');

create temp table unpriced_replay as
select * from public.record_reference_index_provider_result(
  (select run_id from unpriced_run),
  '33333333-3333-4333-a333-333333333333',
  (select attempt_number from unpriced_claim),
  (select lease_token from unpriced_claim),
  'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1',
  '{"schema":"reference-vision-result-v1","rows":[]}'::jsonb,
  'provider-unpriced-1', 123, 45, 0,
  '{"pricingStatus":"unpriced","pricingVersion":null,"unpricedReason":"rate_config_missing_or_invalid"}'::jsonb
);
select is((select replayed from unpriced_replay), true,
  'identical unpriced result replay is idempotent');
select is((select count(*)::integer
  from public.reference_index_provider_calls
  where run_id = (select run_id from unpriced_run)), 1,
  'unpriced replay creates no duplicate provider call');
select throws_ok(
  $$select * from public.record_reference_index_provider_result(
    (select run_id from unpriced_run),
    '33333333-3333-4333-a333-333333333333',
    (select attempt_number from unpriced_claim),
    (select lease_token from unpriced_claim),
    'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1',
    '{"schema":"reference-vision-result-v1","rows":[]}'::jsonb,
    'provider-unpriced-1', 123, 45, 0,
    '{"pricingStatus":"unpriced","pricingVersion":null,"unpricedReason":"changed"}'::jsonb
  )$$,
  '23505', 'provider_result_conflict',
  'replay rejects changed pricing evidence'
);
select throws_ok(
  $$select * from public.record_reference_index_provider_result(
    (select run_id from unpriced_run),
    '33333333-3333-4333-a333-333333333333',
    (select attempt_number from unpriced_claim),
    (select lease_token from unpriced_claim),
    'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee1',
    '{"schema":"reference-vision-result-v1","rows":[]}'::jsonb,
    'provider-unpriced-1', 123, 45, 1,
    '{"pricingStatus":"unpriced"}'::jsonb
  )$$,
  '22023', 'unpriced_provider_result_has_cost',
  'unpriced provider result cannot smuggle a nonzero cost'
);

create temp table priced_run as
select * from public.reserve_reference_index_run(
  '33333333-3333-4333-a333-333333333333',
  'pricing-priced-run',
  pg_temp.pricing_manifest(
    'dddddddd-dddd-4ddd-addd-ddddddddddd2', repeat('b', 64)
  ),
  'reference-index-v1'
);
create temp table priced_claim as
select * from public.claim_reference_index_run(
  (select run_id from priced_run),
  '33333333-3333-4333-a333-333333333333', 600
);
select * from public.begin_reference_index_provider_call(
  (select run_id from priced_run),
  '33333333-3333-4333-a333-333333333333',
  (select attempt_number from priced_claim),
  (select lease_token from priced_claim),
  'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee2',
  'vision', 0, 'gemini-2.5-flash', repeat('2', 64)
);
select * from public.record_reference_index_provider_result(
  (select run_id from priced_run),
  '33333333-3333-4333-a333-333333333333',
  (select attempt_number from priced_claim),
  (select lease_token from priced_claim),
  'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee2',
  '{"schema":"reference-vision-result-v1","rows":[]}'::jsonb,
  'provider-priced-1', 0, 0, 0,
  '{"pricingStatus":"priced","pricingVersion":"env-rate-v1"}'::jsonb
);
select is((select billing_state from public.reference_index_provider_calls
  where id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee2'), 'reported',
  'configured pricing derives reported billing');
select is((select cost_micros from public.reference_index_provider_calls
  where id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee2'), 0::bigint,
  'a genuine configured zero remains a reported zero');
select is((select provider_meta ->> 'pricingStatus'
  from public.reference_index_provider_calls
  where id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee2'), 'priced',
  'reported zero retains explicit priced evidence');
select throws_ok(
  $$select * from public.record_reference_index_provider_result(
    (select run_id from priced_run),
    '33333333-3333-4333-a333-333333333333',
    (select attempt_number from priced_claim),
    (select lease_token from priced_claim),
    'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee2',
    '{"schema":"reference-vision-result-v1","rows":[]}'::jsonb,
    'provider-priced-1', 0, 0, 0, '{}'::jsonb
  )$$,
  '22023', 'invalid_provider_pricing_status',
  'missing pricing status can never become an implicit reported zero'
);
select throws_ok(
  $$select * from public.record_reference_index_provider_result(
    (select run_id from priced_run),
    '33333333-3333-4333-a333-333333333333',
    (select attempt_number from priced_claim),
    (select lease_token from priced_claim),
    'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeee2',
    '{"schema":"reference-vision-result-v1","rows":[]}'::jsonb,
    'provider-priced-1', 0, 0, 0,
    '{"pricingStatus":"estimated"}'::jsonb
  )$$,
  '22023', 'invalid_provider_pricing_status',
  'unknown pricing status is rejected before replay'
);
select ok(not has_function_privilege(
  'authenticated',
  'public.record_reference_index_provider_result(uuid,uuid,integer,uuid,uuid,jsonb,text,bigint,bigint,bigint,jsonb)',
  'EXECUTE'
), 'authenticated clients cannot stage provider billing');
select ok(has_function_privilege(
  'service_role',
  'public.record_reference_index_provider_result(uuid,uuid,integer,uuid,uuid,jsonb,text,bigint,bigint,bigint,jsonb)',
  'EXECUTE'
), 'service_role retains provider result staging access');

select * from finish();
rollback;
