const migrationUrl = new URL(
  "../migrations/20260829023000_reference_index_atomic_lifecycle_v1.sql",
  import.meta.url,
);
const sql = await Deno.readTextFile(migrationUrl);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function includesAll(
  source: string,
  needles: readonly string[],
  scope: string,
) {
  for (const needle of needles) {
    assert(source.includes(needle), `${scope} is missing: ${needle}`);
  }
}

function functionSql(name: string): string {
  const startMarker = `create or replace function public.${name}(`;
  const start = sql.indexOf(startMarker);
  assert(start >= 0, `missing function ${name}`);
  const end = sql.indexOf("\n$$;", start);
  assert(end > start, `unterminated function ${name}`);
  return sql.slice(start, end + 4);
}

function assertOrdered(
  source: string,
  earlier: string,
  later: string,
  scope: string,
) {
  const earlierAt = source.indexOf(earlier);
  const laterAt = source.indexOf(later);
  assert(earlierAt >= 0, `${scope} is missing earlier anchor: ${earlier}`);
  assert(laterAt >= 0, `${scope} is missing later anchor: ${later}`);
  assert(earlierAt < laterAt, `${scope} has unsafe ordering: ${earlier}`);
}

Deno.test("migration is forward-only and transaction-wrapped", () => {
  assert(
    sql.trimStart().startsWith("-- Close the remaining reference-index"),
    "unexpected migration header",
  );
  assert(/^begin;/m.test(sql), "migration must begin a transaction");
  assert(/commit;\s*$/.test(sql), "migration must commit exactly at EOF");
  assert(
    !/\bdrop table\b/i.test(sql),
    "forward migration must not drop tables",
  );
});

Deno.test("asset claim shape supports bound and expiring provisional claims", () => {
  includesAll(sql, [
    "reference_index_run_id uuid",
    "reference_index_claimed_at timestamptz",
    "reference_index_claim_expires_at timestamptz",
    "references public.reference_index_runs(id)",
    "on delete set null",
    "now() + interval '15 minutes'",
    "inspiration_assets_reference_index_claim_shape check",
    "inspiration_assets_reference_index_orphan_idx",
  ], "asset claim contract");
});

Deno.test("run reservation locks, validates, inserts, and binds atomically", () => {
  const reserve = functionSql("reserve_reference_index_run");
  includesAll(reserve, [
    "pg_advisory_xact_lock",
    "reference_manifest_requested_ids_not_canonical",
    "reference_manifest_assets_not_canonical",
    "for update;",
    "reference_asset_rights_or_owner_mismatch",
    "reference_asset_provisional_claim_expired",
    "reference_asset_already_claimed",
    "reference_asset_content_conflict",
    "insert into public.reference_index_runs",
    "insert into public.reference_index_run_items",
    "reference_index_run_id = v_run.id",
    "reference_index_claim_expires_at = null",
    "reference_asset_claim_race",
  ], "reserve_reference_index_run");
  assertOrdered(
    reserve,
    "select * into v_asset",
    "insert into public.reference_index_runs",
    "asset validation before run insert",
  );
  assertOrdered(
    reserve,
    "insert into public.reference_index_runs",
    "reference_index_run_id = v_run.id",
    "run insert before asset binding",
  );
});

Deno.test("provider-call reservation revalidates live rights and hashes under locks", () => {
  const beginCall = functionSql("begin_reference_index_provider_call");
  includesAll(beginCall, [
    "for update of a",
    "a.reference_index_run_id = v_run.id",
    "a.rights in ('owned', 'licensed')",
    "a.usable_for_conditioning",
    "a.storage_path = m.item ->> 'storagePath'",
    "a.content_sha256 = i.content_sha256",
    "a.conditioning_sha256 = i.conditioning_sha256",
    "a.conditioning_storage_path =",
    "m.item ->> 'conditioningStoragePath'",
    "reference_rights_or_hash_revalidation_failed",
    "insert into public.reference_index_provider_calls",
  ], "begin_reference_index_provider_call");
  assertOrdered(
    beginCall,
    "for update of a",
    "insert into public.reference_index_provider_calls",
    "asset locks before provider-call insert",
  );
  assertOrdered(
    beginCall,
    "reference_rights_or_hash_revalidation_failed",
    "insert into public.reference_index_provider_calls",
    "rights/hash check before provider-call insert",
  );
});

Deno.test("pre-provider failure is CAS-protected, replayable, and releases claims", () => {
  const failRun = functionSql("fail_reference_index_run");
  includesAll(failRun, [
    "if v_run.status = 'failed' then",
    "v_run.attempt_number = p_attempt_number",
    "reference_failure_conflict",
    "reference_index_lease_lost",
    "pre_provider_failure_has_provider_call",
    "status = 'failed'",
    "reference_index_run_id = null",
  ], "fail_reference_index_run");
  assertOrdered(
    failRun,
    "if v_run.status = 'failed' then",
    "reference_index_lease_lost",
    "terminal replay before lease predicate",
  );
  assertOrdered(
    failRun,
    "reference_index_lease_lost",
    "pre_provider_failure_has_provider_call",
    "active-attempt CAS before no-call assertion",
  );
});

Deno.test("provider terminal failure replay precedes active lease validation", () => {
  const failure = functionSql("record_reference_index_provider_failure");
  includesAll(failure, [
    "if v_call.status <> 'prepared' then",
    "v_call.attempt_number = p_attempt_number",
    "reference_provider_failure_conflict",
    "reference_index_lease_lost",
    "billing_state = v_billing",
    "reference_index_run_id = null",
  ], "record_reference_index_provider_failure");
  assertOrdered(
    failure,
    "if v_call.status <> 'prepared' then",
    "reference_index_lease_lost",
    "terminal call replay before active-run lease predicate",
  );
});

Deno.test("reaper distinguishes retry-safe and ambiguous lease expiry", () => {
  const reap = functionSql("reap_stale_reference_index_work");
  includesAll(reap, [
    "for update skip locked",
    "reference_provisional_claim_expired",
    "c.status = 'prepared'",
    "billing_state = 'unknown'",
    "status = 'indeterminate'",
    "status = 'reserved'",
    "lease_expired_requeued",
    "reservation_expired",
    "reference_index_run_id = null",
  ], "reap_stale_reference_index_work");
});

Deno.test("all mutation RPCs are service-role only", () => {
  for (
    const signature of [
      "reserve_reference_index_run(uuid, text, jsonb, text)",
      "claim_reference_index_run(uuid, uuid, integer)",
      "fail_reference_index_run(\n  uuid, uuid, integer, uuid, text, text\n)",
      "reap_stale_reference_index_work(integer, integer)",
    ]
  ) {
    assert(
      sql.includes(`revoke all on function public.${signature}`),
      `missing public/anon/authenticated revoke for ${signature}`,
    );
    assert(
      sql.includes(`grant execute on function public.${signature}`),
      `missing service_role grant for ${signature}`,
    );
  }
});
