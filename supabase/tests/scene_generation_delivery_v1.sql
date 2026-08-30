-- Executable, rollback-only acceptance test for scene delivery integrity.
-- Run after all migrations, for example:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/scene_generation_delivery_v1.sql

begin;
set local statement_timeout = '30s';
set constraints all deferred;

do $test$
declare
  v_profile uuid := 'f0000000-0000-4000-8000-000000000001';
  v_job0 uuid := 'f1000000-0000-4000-8000-000000000001';
  v_job1 uuid := 'f1000000-0000-4000-8000-000000000002';
  v_attempt0 uuid := 'f2000000-0000-4000-8000-000000000001';
  v_attempt1 uuid := 'f2000000-0000-4000-8000-000000000002';
  v_lease0 uuid := 'f3000000-0000-4000-8000-000000000001';
  v_lease1 uuid := 'f3000000-0000-4000-8000-000000000002';
  v_call0 uuid := 'f4000000-0000-4000-8000-000000000001';
  v_rejected_call0 uuid := 'f4000000-0000-4000-8000-000000000002';
  v_reroll_call uuid := 'f4000000-0000-4000-8000-000000000003';
  v_fixed_asset uuid := '10000000-0000-4000-8000-000000000001';
  v_unsafe_asset uuid := '10000000-0000-4000-8000-000000000002';
  v_ref_a uuid := '20000000-0000-4000-8000-000000000001';
  v_ref_b uuid := '20000000-0000-4000-8000-000000000002';
  v_ref_c uuid := '20000000-0000-4000-8000-000000000003';
  v_ref_d uuid := '20000000-0000-4000-8000-000000000004';
  v_ref_e uuid := '20000000-0000-4000-8000-000000000005';
  v_ref_f uuid := '20000000-0000-4000-8000-000000000006';
  v_request_manifest jsonb;
  v_zero_vector text;
  v_embedding_digest text;
  v_fixed_manifest jsonb;
  v_fixed_snapshot0 uuid;
  v_fixed_snapshot1 uuid;
  v_fixed_manifest_hash text;
  v_ref_snapshot0 uuid;
  v_ref_snapshot1 uuid;
  v_ref_manifest0 text;
  v_ref_manifest1 text;
  v_authorized boolean;
  v_invoke boolean;
  v_returned_call uuid;
  v_call_status text;
  v_funding text;
  v_decision text;
  v_reroll_allowed boolean;
  v_failed boolean;
  v_evidence jsonb;
begin
  v_zero_vector := '[' || array_to_string(
    array_fill(0::integer, array[768]),
    ','
  ) || ']';

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_profile,
    'authenticated', 'authenticated', 'scene-integrity-test@example.invalid',
    '', now(), '{}'::jsonb, '{"name":"Scene integrity test"}'::jsonb,
    now(), now()
  );
  update public.profiles
  set age_range = '30_plus'
  where id = v_profile;

  -- One valid owner-scoped fixed reference and one deliberately ineligible
  -- row prove the fixed snapshot RPC re-checks rights/index state.
  insert into public.inspiration_assets (
    id, profile_id, storage_path, source, description, embedding,
    visual_embedding, embedding_model, indexing_version, index_status,
    content_sha256, conditioning_sha256, rights,
    usable_for_conditioning, indexed_at, conditioning_storage_bucket,
    conditioning_storage_path
  ) values (
    v_fixed_asset, v_profile, v_profile::text || '/manual.jpg',
    'user_upload', 'valid owner reference',
    v_zero_vector::extensions.vector, v_zero_vector::extensions.vector,
    'gemini-embedding-2', 'reference-index-v1', 'ready',
    repeat('0', 64), repeat('1', 64), 'owned', true, now(),
    'inspiration-conditioning',
    v_profile::text || '/reference/' || v_fixed_asset::text || '/' ||
      repeat('1', 64) || '.jpg'
  ), (
    v_unsafe_asset, v_profile, v_profile::text || '/unsafe.jpg',
    'user_upload', null, null, null, null, null, 'pending',
    null, null, 'unverified', false, null, null, null
  );

  -- Six rights-eligible rows back the two disjoint exact-three retrieval
  -- snapshots. The snapshot RPC itself is then tested for exact cardinality.
  insert into public.inspiration_assets (
    id, profile_id, storage_path, source, style_pack_id, description,
    embedding, visual_embedding, embedding_model, indexing_version,
    index_status, content_sha256, conditioning_sha256, rights,
    usable_for_conditioning, indexed_at, conditioning_storage_bucket,
    conditioning_storage_path
  )
  select asset_id, null, '_global/packs/test/' || ordinality || '.jpg',
    'style_pack', 'test', 'licensed test reference',
    v_zero_vector::extensions.vector, v_zero_vector::extensions.vector,
    'gemini-embedding-2', 'reference-index-v1', 'ready',
    repeat(content_digit, 64), repeat(conditioning_digit, 64),
    'licensed', true, now(), 'inspiration-conditioning',
    'style-pack/' || asset_id::text || '/' ||
      repeat(conditioning_digit, 64) || '.jpg'
  from unnest(
    array[v_ref_a, v_ref_b, v_ref_c, v_ref_d, v_ref_e, v_ref_f],
    array['6','7','8','9','a','b'],
    array['a','b','c','d','e','f']
  ) with ordinality as refs(
    asset_id, content_digit, conditioning_digit, ordinality
  );

  select encode(
    extensions.digest(convert_to(visual_embedding::text, 'UTF8'), 'sha256'),
    'hex'
  ) into v_embedding_digest
  from public.inspiration_assets
  where id = v_fixed_asset;
  v_fixed_manifest := jsonb_build_object(
    'schema', 'scene-fixed-reference-v1',
    'references', jsonb_build_array(jsonb_build_object(
      'attachmentIndex', 0,
      'attachmentPlacement', 'before_retrieval',
      'kind', 'user_inspiration',
      'sha256', repeat('1', 64),
      'assetId', v_fixed_asset,
      'storageBucket', 'inspiration-conditioning',
      'storagePath', v_profile::text || '/reference/' ||
        v_fixed_asset::text || '/' || repeat('1', 64) || '.jpg',
      'embeddingModel', 'gemini-embedding-2',
      'embeddingDigest', v_embedding_digest
    ))
  );
  v_request_manifest := jsonb_build_object(
    'schema', 'scene-request-v1',
    'mode', 'background',
    'quality', 'standard',
    'provider', 'google-gemini',
    'model_ref', 'gemini-test-image',
    'prompt_version', 'scene-server-v1',
    'units', 1,
    'request', jsonb_build_object('prompt', 'integrity test')
  );

  insert into public.generation_jobs (
    id, profile_id, idempotency_key, batch_id, request_manifest,
    request_hash, status, mode, quality, provider, model_ref,
    prompt_version, units, reservation_expires_at, active_attempt_id,
    lease_token, lease_expires_at, started_at
  ) values
  (
    v_job0, v_profile, 'integrity-request-0001', 'integrity-batch-0001',
    v_request_manifest, public.scene_manifest_sha256(v_request_manifest),
    'generating', 'background', 'standard', 'google-gemini',
    'gemini-test-image', 'scene-server-v1', 1, now() + interval '1 hour',
    v_attempt0, v_lease0, now() + interval '10 minutes', now()
  ),
  (
    v_job1, v_profile, 'integrity-request-0002', 'integrity-batch-0002',
    v_request_manifest, public.scene_manifest_sha256(v_request_manifest),
    'generating', 'background', 'standard', 'google-gemini',
    'gemini-test-image', 'scene-server-v1', 1, now() + interval '1 hour',
    v_attempt1, v_lease1, now() + interval '10 minutes', now()
  );
  insert into public.generation_attempts (
    id, job_id, profile_id, attempt_number, lease_token,
    lease_expires_at, status, provider, model_ref
  ) values
  (v_attempt0, v_job0, v_profile, 1, v_lease0,
    now() + interval '10 minutes', 'started', 'google-gemini',
    'gemini-test-image'),
  (v_attempt1, v_job1, v_profile, 1, v_lease1,
    now() + interval '10 minutes', 'started', 'google-gemini',
    'gemini-test-image');
  insert into public.credit_reservations (
    job_id, profile_id, period_start, units
  ) values
    (v_job0, v_profile, date_trunc('month', now())::date, 1),
    (v_job1, v_profile, date_trunc('month', now())::date, 1);

  -- Exact-three: a two-reference snapshot must fail atomically.
  v_failed := false;
  begin
    perform public.record_scene_reference_snapshot(
      v_job0, v_profile, v_attempt0, v_lease0, 0,
      repeat('2', 64), repeat('3', 64), 'test', '{}'::jsonb,
      array[repeat('a', 64), repeat('b', 64)], '{}'::text[],
      array[v_ref_a, v_ref_b],
      array[repeat('a', 64), repeat('b', 64)], '[]'::jsonb
    );
  exception when others then
    v_failed := true;
  end;
  if not v_failed or exists (
    select 1 from public.generation_reference_snapshots where job_id = v_job0
  ) then
    raise exception 'acceptance_exact_three_failed';
  end if;

  select snapshot_id, manifest_hash
  into v_ref_snapshot0, v_ref_manifest0
  from public.record_scene_reference_snapshot(
    v_job0, v_profile, v_attempt0, v_lease0, 0,
    repeat('2', 64), repeat('3', 64), 'test',
    '{"schema":"retrieved-test-0"}'::jsonb,
    array[repeat('a',64), repeat('b',64), repeat('c',64)],
    '{}'::text[], array[v_ref_a,v_ref_b,v_ref_c],
    array[repeat('a',64), repeat('b',64), repeat('c',64)],
    '[]'::jsonb
  );

  select snapshot_id, manifest_hash
  into v_fixed_snapshot0, v_fixed_manifest_hash
  from public.record_scene_fixed_reference_snapshot(
    v_job0, v_profile, v_attempt0, v_lease0, v_fixed_manifest,
    array[repeat('1',64)], array['user_inspiration'],
    array[v_embedding_digest]
  );

  -- Both retrieved and fixed snapshots are sealed against in-place rewrite.
  foreach v_ref_snapshot1 in array array[v_ref_snapshot0, v_fixed_snapshot0]
  loop
    v_failed := false;
    begin
      if v_ref_snapshot1 = v_ref_snapshot0 then
        update public.generation_reference_snapshots
        set manifest = manifest || '{"tampered":true}'::jsonb
        where id = v_ref_snapshot1;
      else
        update public.generation_fixed_reference_snapshots
        set manifest = manifest || '{"tampered":true}'::jsonb
        where id = v_ref_snapshot1;
      end if;
    exception when sqlstate '55000' then
      v_failed := true;
    end;
    if not v_failed then
      raise exception 'acceptance_snapshot_immutability_failed';
    end if;
  end loop;

  select invoke_allowed, provider_call_id, call_status, funding_source
  into v_invoke, v_returned_call, v_call_status, v_funding
  from public.reserve_scene_provider_call_v2(
    v_job0, v_profile, v_attempt0, v_lease0, v_call0, 0,
    'google-gemini', 'gemini-test-image', repeat('4',64),
    v_ref_manifest0,
    array[repeat('a',64),repeat('b',64),repeat('c',64)],
    v_fixed_snapshot0, array[repeat('1',64)], '{}'::text[]
  );
  if not v_invoke or v_returned_call <> v_call0
    or v_funding <> 'user_reserved' then
    raise exception 'acceptance_initial_funding_failed';
  end if;

  -- Exactly 0.95 is accepted, so it cannot unlock a reroll.
  select decision, reroll_allowed into v_decision, v_reroll_allowed
  from public.record_scene_provider_candidate(
    v_job0, v_profile, v_attempt0, v_lease0, v_call0,
    'provider-request-0', 'provider-response-0', 'image/jpeg',
    1024, 1280, repeat('9',64), repeat('8',64), 0.95,
    'retrieved_style', repeat('a',64), 1, 1, 1, '{}'::jsonb
  );
  if v_decision <> 'accepted' or v_reroll_allowed then
    raise exception 'acceptance_strict_threshold_failed';
  end if;

  v_failed := false;
  begin
    perform public.reserve_scene_provider_call_v2(
      v_job0, v_profile, v_attempt0, v_lease0,
      'f4000000-0000-4000-8000-000000000004', 1,
      'google-gemini', 'gemini-test-image', repeat('5',64),
      repeat('6',64),
      array[repeat('d',64),repeat('e',64),repeat('f',64)],
      v_fixed_snapshot0, array[repeat('1',64)], '{}'::text[]
    );
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'acceptance_reroll_without_rejection_failed';
  end if;

  -- Wrong output bytes cannot be authorized; the exact accepted hash can.
  v_failed := false;
  begin
    perform public.authorize_scene_output_upload_v2(
      v_job0, v_profile, v_attempt0, v_lease0, v_call0, repeat('7',64)
    );
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'acceptance_wrong_hash_authorized';
  end if;
  select authorized into v_authorized
  from public.authorize_scene_output_upload_v2(
    v_job0, v_profile, v_attempt0, v_lease0, v_call0, repeat('9',64)
  );
  if not v_authorized then
    raise exception 'acceptance_exact_hash_not_authorized';
  end if;

  v_evidence := jsonb_build_object(
    'provider_call_id', v_call0,
    'candidate_index', 0,
    'funding_source', 'user_reserved',
    'output_content_sha256', repeat('9',64),
    'output_embedding_digest', repeat('8',64),
    'reference_snapshot_id', v_ref_snapshot0,
    'reference_manifest_hash', v_ref_manifest0,
    'retrieved_aesthetic_hashes',
      array[repeat('a',64),repeat('b',64),repeat('c',64)],
    'fixed_reference_snapshot_id', v_fixed_snapshot0,
    'fixed_reference_manifest_hash', v_fixed_manifest_hash,
    'fixed_reference_hashes', array[repeat('1',64)],
    'fixed_reference_embedding_digests', array[v_embedding_digest],
    'identity_reference_hashes', '{}'::text[],
    'anti_copy_policy_version', 'scene-anti-copy-v1',
    'anti_copy_threshold', 0.95,
    'maximum_similarity', 0.95,
    'matched_reference_kind', 'retrieved_style',
    'matched_reference_sha256', repeat('a',64)
  );
  v_failed := false;
  begin
    update public.generation_jobs
    set pending_storage_bucket = 'edits',
        pending_storage_path = public.scene_output_storage_path(
          v_profile, v_job0, 'image/jpeg'
        ),
        pending_mime_type = 'image/jpeg', pending_width = 1024,
        pending_height = 1280, pending_content_sha256 = repeat('7',64),
        provider_completed_at = now(), output_recorded_at = now(),
        finalization_payload = jsonb_build_object(
          'provenance', jsonb_build_object(
            'accepted_provider_call', v_evidence
          )
        )
    where id = v_job0;
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'acceptance_output_hash_guard_failed';
  end if;
  update public.generation_jobs
  set pending_storage_bucket = 'edits',
      pending_storage_path = public.scene_output_storage_path(
        v_profile, v_job0, 'image/jpeg'
      ),
      pending_mime_type = 'image/jpeg', pending_width = 1024,
      pending_height = 1280, pending_content_sha256 = repeat('9',64),
      provider_completed_at = now(), output_recorded_at = now(),
      finalization_payload = jsonb_build_object(
        'provenance', jsonb_build_object('accepted_provider_call', v_evidence)
      )
  where id = v_job0;

  -- An ineligible fixed reference cannot be snapshotted, even via the
  -- service-only RPC. The failed subtransaction leaves no partial row.
  v_failed := false;
  begin
    perform public.record_scene_fixed_reference_snapshot(
      v_job1, v_profile, v_attempt1, v_lease1,
      jsonb_build_object(
        'schema', 'scene-fixed-reference-v1',
        'references', jsonb_build_array(jsonb_build_object(
          'attachmentIndex', 0,
          'attachmentPlacement', 'before_retrieval',
          'kind', 'user_inspiration',
          'sha256', repeat('7',64),
          'assetId', v_unsafe_asset,
          'storageBucket', 'inspiration-conditioning',
          'storagePath', v_profile::text || '/unsafe.jpg',
          'embeddingModel', 'gemini-embedding-2',
          'embeddingDigest', repeat('8',64)
        ))
      ), array[repeat('7',64)], array['user_inspiration'],
      array[repeat('8',64)]
    );
  exception when others then
    v_failed := true;
  end;
  if not v_failed or exists (
    select 1 from public.generation_fixed_reference_snapshots
    where job_id = v_job1
  ) then
    raise exception 'acceptance_rights_safe_fixed_snapshot_failed';
  end if;

  select snapshot_id, manifest_hash
  into v_fixed_snapshot1, v_fixed_manifest_hash
  from public.record_scene_fixed_reference_snapshot(
    v_job1, v_profile, v_attempt1, v_lease1, v_fixed_manifest,
    array[repeat('1',64)], array['user_inspiration'],
    array[v_embedding_digest]
  );
  select snapshot_id, manifest_hash
  into v_ref_snapshot0, v_ref_manifest0
  from public.record_scene_reference_snapshot(
    v_job1, v_profile, v_attempt1, v_lease1, 0,
    repeat('2',64), repeat('3',64), 'test',
    '{"schema":"retrieved-test-job1-0"}'::jsonb,
    array[repeat('a',64),repeat('b',64),repeat('c',64)],
    '{}'::text[], array[v_ref_a,v_ref_b,v_ref_c],
    array[repeat('a',64),repeat('b',64),repeat('c',64)], '[]'::jsonb
  );
  select snapshot_id, manifest_hash
  into v_ref_snapshot1, v_ref_manifest1
  from public.record_scene_reference_snapshot(
    v_job1, v_profile, v_attempt1, v_lease1, 1,
    repeat('2',64), repeat('3',64), 'test',
    '{"schema":"retrieved-test-job1-1"}'::jsonb,
    array[repeat('d',64),repeat('e',64),repeat('f',64)],
    '{}'::text[], array[v_ref_d,v_ref_e,v_ref_f],
    array[repeat('d',64),repeat('e',64),repeat('f',64)], '[]'::jsonb
  );

  perform public.reserve_scene_provider_call_v2(
    v_job1, v_profile, v_attempt1, v_lease1, v_rejected_call0, 0,
    'google-gemini', 'gemini-test-image', repeat('4',64),
    v_ref_manifest0,
    array[repeat('a',64),repeat('b',64),repeat('c',64)],
    v_fixed_snapshot1, array[repeat('1',64)], '{}'::text[]
  );
  select decision, reroll_allowed into v_decision, v_reroll_allowed
  from public.record_scene_provider_candidate(
    v_job1, v_profile, v_attempt1, v_lease1, v_rejected_call0,
    'provider-request-1', 'provider-response-1', 'image/jpeg',
    1024, 1280, repeat('6',64), repeat('5',64), 0.951,
    'retrieved_style', repeat('a',64), 1, 1, 1, '{}'::jsonb
  );
  if v_decision <> 'copy_rejected' or not v_reroll_allowed
    or (select status from public.credit_reservations where job_id = v_job1)
      <> 'reserved' then
    raise exception 'acceptance_rejected_funding_or_credit_failed';
  end if;

  v_failed := false;
  begin
    perform public.authorize_scene_output_upload_v2(
      v_job1, v_profile, v_attempt1, v_lease1,
      v_rejected_call0, repeat('6',64)
    );
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'acceptance_rejected_output_authorized';
  end if;

  select invoke_allowed, provider_call_id, call_status, funding_source
  into v_invoke, v_returned_call, v_call_status, v_funding
  from public.reserve_scene_provider_call_v2(
    v_job1, v_profile, v_attempt1, v_lease1, v_reroll_call, 1,
    'google-gemini', 'gemini-test-image', repeat('5',64),
    v_ref_manifest1,
    array[repeat('d',64),repeat('e',64),repeat('f',64)],
    v_fixed_snapshot1, array[repeat('1',64)], '{}'::text[]
  );
  if not v_invoke or v_funding <> 'system_anti_copy' then
    raise exception 'acceptance_system_reroll_funding_failed';
  end if;
  perform public.record_scene_provider_candidate(
    v_job1, v_profile, v_attempt1, v_lease1, v_reroll_call,
    'provider-request-2', 'provider-response-2', 'image/jpeg',
    1024, 1280, repeat('7',64), repeat('4',64), 0.951,
    'retrieved_style', repeat('d',64), 1, 1, 1, '{}'::jsonb
  );

  -- Replay resolves to the same row; candidate index 2 is impossible; the
  -- ledger therefore remains capped at two calls with derived funding.
  select invoke_allowed, provider_call_id into v_invoke, v_returned_call
  from public.reserve_scene_provider_call_v2(
    v_job1, v_profile, v_attempt1, v_lease1,
    'f4000000-0000-4000-8000-000000000005', 1,
    'google-gemini', 'gemini-test-image', repeat('5',64),
    v_ref_manifest1,
    array[repeat('d',64),repeat('e',64),repeat('f',64)],
    v_fixed_snapshot1, array[repeat('1',64)], '{}'::text[]
  );
  if v_invoke or v_returned_call <> v_reroll_call then
    raise exception 'acceptance_provider_call_replay_failed';
  end if;
  v_failed := false;
  begin
    perform public.reserve_scene_provider_call_v2(
      v_job1, v_profile, v_attempt1, v_lease1,
      'f4000000-0000-4000-8000-000000000006', 2,
      'google-gemini', 'gemini-test-image', repeat('5',64),
      v_ref_manifest1,
      array[repeat('d',64),repeat('e',64),repeat('f',64)],
      v_fixed_snapshot1, array[repeat('1',64)], '{}'::text[]
    );
  exception when others then
    v_failed := true;
  end;
  if not v_failed
    or (select count(*) from public.generation_provider_calls
        where job_id = v_job1) <> 2
    or (select funding_source from public.generation_provider_calls
        where job_id = v_job1 and call_index = 0) <> 'user_reserved'
    or (select funding_source from public.generation_provider_calls
        where job_id = v_job1 and call_index = 1) <> 'system_anti_copy' then
    raise exception 'acceptance_max_two_or_funding_failed';
  end if;

  v_failed := false;
  begin
    update public.generation_jobs
    set accepted_provider_call_id = v_reroll_call
    where id = v_job1;
  exception when others then
    v_failed := true;
  end;
  if not v_failed
    or exists (select 1 from public.generation_jobs
      where id = v_job1 and pending_storage_path is not null)
    or (select status from public.credit_reservations where job_id = v_job1)
      <> 'reserved' then
    raise exception 'acceptance_rejected_output_or_credit_boundary_failed';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.generation_jobs'::regclass
      and conname = 'generation_jobs_accepted_provider_call_fk'
      and contype = 'f'
  ) or not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'generation_jobs'
      and indexname = 'generation_jobs_accepted_provider_call_uidx'
  ) or has_function_privilege(
    'service_role',
    'public.reserve_scene_provider_call(uuid,uuid,uuid,uuid,uuid,integer,text,text,text,text,text[],text[])',
    'execute'
  ) or has_function_privilege(
    'service_role',
    'public.authorize_scene_output_upload(uuid,uuid,uuid,uuid,text)',
    'execute'
  ) then
    raise exception 'acceptance_provider_fk_or_unique_missing';
  end if;
end;
$test$;

rollback;
