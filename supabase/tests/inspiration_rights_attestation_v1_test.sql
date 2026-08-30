-- pgTAP acceptance coverage for explicit owner conditioning-rights assertions.
-- Run with `supabase test db` after applying local migrations.

begin;

create extension if not exists pgtap;
select plan(27);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
(
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-a111-111111111111',
  'authenticated', 'authenticated', 'rights-owner@example.invalid', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Rights owner"}'::jsonb, now(), now(), '', '', '', ''
),
(
  '00000000-0000-0000-0000-000000000000',
  '22222222-2222-4222-a222-222222222222',
  'authenticated', 'authenticated', 'rights-other@example.invalid', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Rights other"}'::jsonb, now(), now(), '', '', '', ''
);

insert into public.inspiration_assets (
  id, profile_id, storage_path, label, mime_type, byte_size, source, rights,
  usable_for_conditioning
) values
(
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
  '11111111-1111-4111-a111-111111111111',
  '11111111-1111-4111-a111-111111111111/source/a1.jpg',
  'owned fixture', 'image/jpeg', 1024, 'user_upload', 'unverified', false
),
(
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
  '11111111-1111-4111-a111-111111111111',
  '11111111-1111-4111-a111-111111111111/source/a2.jpg',
  'licensed fixture', 'image/jpeg', 1024, 'user_upload', 'unverified', false
),
(
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
  '11111111-1111-4111-a111-111111111111',
  '11111111-1111-4111-a111-111111111111/source/a3.jpg',
  'rollback fixture', 'image/jpeg', 1024, 'user_upload', 'unverified', false
),
(
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4',
  '11111111-1111-4111-a111-111111111111',
  '11111111-1111-4111-a111-111111111111/source/a4.jpg',
  'basis fixture', 'image/jpeg', 1024, 'user_upload', 'owned', true
),
(
  'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbb1',
  '22222222-2222-4222-a222-222222222222',
  '22222222-2222-4222-a222-222222222222/source/b1.jpg',
  'foreign fixture', 'image/jpeg', 1024, 'user_upload', 'unverified', false
);

select has_table(
  'public', 'inspiration_rights_attestations',
  'append-only rights evidence table exists'
);
select is(
  (select relrowsecurity from pg_catalog.pg_class
    where oid = 'public.inspiration_rights_attestations'::regclass),
  true,
  'rights evidence table has RLS enabled'
);

create temp table first_attestation as
select * from public.attest_inspiration_asset_rights(
  '11111111-1111-4111-a111-111111111111',
  'rights-batch-0001:rights',
  jsonb_build_array(
    jsonb_build_object(
      'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
      'rightsBasis', 'owned',
      'conditioningAuthorized', true,
      'policyVersion', 'conditioning-rights-v1'
    ),
    jsonb_build_object(
      'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
      'rightsBasis', 'licensed',
      'conditioningAuthorized', true,
      'policyVersion', 'conditioning-rights-v1'
    )
  )
);

select is((select count(*)::integer from first_attestation), 2,
  'mixed owned/licensed batch returns one evidence row per asset');
select ok((select bool_and(not replayed) from first_attestation),
  'first attestation rows are not replays');
select is((select rights from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1'), 'owned',
  'owned basis is persisted');
select is((select usable_for_conditioning from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1'), true,
  'owned assertion enables conditioning');
select is((select rights from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2'), 'licensed',
  'licensed basis is persisted');
select is((select usable_for_conditioning from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2'), true,
  'licensed assertion enables conditioning');
select is((select count(*)::integer
  from public.inspiration_rights_attestations), 2,
  'first batch appends exactly two audit rows');
select is((select count(distinct request_hash)::integer
  from public.inspiration_rights_attestations), 1,
  'one canonical request hash binds the batch');

create temp table replay_attestation as
select * from public.attest_inspiration_asset_rights(
  '11111111-1111-4111-a111-111111111111',
  'rights-batch-0001:rights',
  jsonb_build_array(
    jsonb_build_object(
      'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
      'rightsBasis', 'owned',
      'conditioningAuthorized', true,
      'policyVersion', 'conditioning-rights-v1'
    ),
    jsonb_build_object(
      'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
      'rightsBasis', 'licensed',
      'conditioningAuthorized', true,
      'policyVersion', 'conditioning-rights-v1'
    )
  )
);
select is((select count(*)::integer from replay_attestation), 2,
  'idempotent replay returns the original evidence');
select ok((select bool_and(replayed) from replay_attestation),
  'replayed evidence is labeled');
select is((select count(*)::integer
  from public.inspiration_rights_attestations), 2,
  'idempotent replay appends no duplicate evidence');

select throws_ok(
  $$select * from public.attest_inspiration_asset_rights(
    '11111111-1111-4111-a111-111111111111',
    'rights-batch-0001:rights',
    jsonb_build_array(jsonb_build_object(
      'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
      'rightsBasis', 'licensed',
      'conditioningAuthorized', true,
      'policyVersion', 'conditioning-rights-v1'
    )))$$,
  '23505', 'inspiration_rights_attestation_idempotency_conflict',
  'same idempotency key rejects a different assertion payload'
);

select throws_ok(
  $$select * from public.attest_inspiration_asset_rights(
    '11111111-1111-4111-a111-111111111111',
    'rights-batch-noncanonical',
    jsonb_build_array(
      jsonb_build_object(
        'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
        'rightsBasis', 'licensed', 'conditioningAuthorized', true,
        'policyVersion', 'conditioning-rights-v1'
      ),
      jsonb_build_object(
        'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
        'rightsBasis', 'owned', 'conditioningAuthorized', true,
        'policyVersion', 'conditioning-rights-v1'
      )
    ))$$,
  '22023', 'inspiration_rights_attestations_not_canonical',
  'noncanonical asset order is rejected'
);

select throws_ok(
  $$select * from public.attest_inspiration_asset_rights(
    '11111111-1111-4111-a111-111111111111',
    'rights-batch-foreign',
    jsonb_build_array(
      jsonb_build_object(
        'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
        'rightsBasis', 'owned', 'conditioningAuthorized', true,
        'policyVersion', 'conditioning-rights-v1'
      ),
      jsonb_build_object(
        'assetId', 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbb1',
        'rightsBasis', 'owned', 'conditioningAuthorized', true,
        'policyVersion', 'conditioning-rights-v1'
      )
    ))$$,
  '42501', 'inspiration_rights_attestation_forbidden',
  'a foreign asset rejects the entire assertion batch'
);
select is((select rights from public.inspiration_assets
  where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3'), 'unverified',
  'foreign-asset rejection rolls back the valid asset eligibility write');
select is((select count(*)::integer
  from public.inspiration_rights_attestations
  where idempotency_key = 'rights-batch-foreign'), 0,
  'foreign-asset rejection appends no partial audit evidence');

select throws_ok(
  $$select * from public.attest_inspiration_asset_rights(
    '11111111-1111-4111-a111-111111111111',
    'rights-batch-conflict',
    jsonb_build_array(jsonb_build_object(
      'assetId', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4',
      'rightsBasis', 'licensed', 'conditioningAuthorized', true,
      'policyVersion', 'conditioning-rights-v1'
    )))$$,
  '23505', 'inspiration_rights_basis_conflict',
  'an existing explicit basis cannot be silently changed'
);
select is((select count(*)::integer
  from public.inspiration_rights_attestations
  where idempotency_key = 'rights-batch-conflict'), 0,
  'basis conflict appends no evidence');

select ok(not has_function_privilege(
  'authenticated',
  'public.attest_inspiration_asset_rights(uuid,text,jsonb)',
  'EXECUTE'
), 'authenticated clients cannot execute the attestation RPC directly');
select ok(has_function_privilege(
  'service_role',
  'public.attest_inspiration_asset_rights(uuid,text,jsonb)',
  'EXECUTE'
), 'service_role can execute the attestation RPC');
select ok(has_table_privilege(
  'authenticated', 'public.inspiration_rights_attestations', 'SELECT'
), 'authenticated owners can select audit evidence through RLS');
select ok(not has_table_privilege(
  'authenticated', 'public.inspiration_rights_attestations', 'INSERT'
), 'authenticated clients cannot append audit evidence directly');
select ok(not has_table_privilege(
  'service_role', 'public.inspiration_rights_attestations', 'INSERT'
), 'service_role bypass is confined to the security-definer RPC');
select ok(not has_column_privilege(
  'authenticated', 'public.inspiration_assets', 'rights', 'UPDATE'
), 'authenticated clients cannot update the rights column directly');

delete from public.inspiration_assets
where id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
select is((select count(*)::integer
  from public.inspiration_rights_attestations
  where asset_id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1'), 0,
  'asset/account deletion cascades its owner audit evidence');

select * from finish();
rollback;
