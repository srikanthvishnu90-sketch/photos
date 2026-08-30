const migrationUrl = new URL(
  "../migrations/20260829026000_edit_generation_lifecycle_v1.sql",
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
  const marker = `create or replace function public.${name}(`;
  const start = sql.indexOf(marker);
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
  assert(earlierAt >= 0, `${scope} missing earlier anchor: ${earlier}`);
  assert(laterAt >= 0, `${scope} missing later anchor: ${later}`);
  assert(earlierAt < laterAt, `${scope} unsafe ordering: ${earlier}`);
}

Deno.test("edit lifecycle migration is forward-only and transaction-wrapped", () => {
  assert(/^begin;/m.test(sql), "migration must begin a transaction");
  assert(/commit;\s*$/.test(sql), "migration must commit at EOF");
  assert(!/RPC_INSERT_POINT/.test(sql), "temporary insertion marker remains");
  assert(!/\bdrop\s+(table|column|function)\b/i.test(sql), "migration is destructive");
});

Deno.test("request manifest stores hashes and bounded metadata, never source bytes", () => {
  const validator = functionSql("edit_request_manifest_valid");
  includesAll(validator, [
    "jsonb_object_keys(p_manifest)) <> 11",
    "edit-request-v1",
    "inputSha256",
    "instructionSha256",
    "hasMask",
    "maskSha256",
    "^[a-f0-9]{64}$",
  ], "request manifest validator");
  for (const forbidden of ["inputBase64", "maskBase64", "instructionText"]) {
    assert(!validator.includes(forbidden), `manifest persists ${forbidden}`);
  }
});

Deno.test("edit tables encode ownership, lifetime idempotency, and cascade deletion", () => {
  includesAll(sql, [
    "create table public.edit_generation_jobs",
    "unique (profile_id, idempotency_key)",
    "unique (id, profile_id)",
    "references public.profiles(id) on delete cascade",
    "foreign key (taste_event_id) references public.taste_events(id)",
    "on delete no action deferrable initially deferred",
    "create table public.edit_quota_reservations",
    "job_id uuid primary key",
    "create table public.edit_provider_calls",
    "job_id uuid not null unique",
    "foreign key (job_id, profile_id)",
    "references public.edit_generation_jobs(id, profile_id) on delete cascade",
  ], "edit schema");
});

Deno.test("states distinguish every required crash boundary", () => {
  includesAll(sql, [
    "'reserved', 'processing', 'provider_prepared', 'result_captured'",
    "'delivered', 'failed', 'indeterminate'",
    "state in ('held', 'charged', 'released')",
    "'prepared', 'succeeded', 'rejected', 'failed', 'indeterminate'",
  ], "state machines");
});

Deno.test("reservation serializes per owner and counts held plus charged quota", () => {
  const reserve = functionSql("reserve_edit_generation");
  includesAll(reserve, [
    "pg_advisory_xact_lock",
    "j.idempotency_key = p_idempotency_key",
    "edit_generation_idempotency_conflict",
    "for update;",
    "q.state in ('held', 'charged')",
    "edit_quota_exhausted",
    "insert into public.edit_generation_jobs",
    "insert into public.edit_quota_reservations",
  ], "reserve_edit_generation");
  assertOrdered(
    reserve,
    "j.idempotency_key = p_idempotency_key",
    "from public.profiles p",
    "idempotency replay before quota evaluation",
  );
  assertOrdered(
    reserve,
    "from public.profiles p",
    "q.state in ('held', 'charged')",
    "profile lock before quota count",
  );
});

Deno.test("claim is caller-token replayable and only reclaims pre-provider work", () => {
  const claim = functionSql("claim_edit_generation");
  includesAll(claim, [
    "v_job.lease_token = p_lease_token",
    "return query select true, true",
    "v_job.status not in ('reserved', 'processing')",
    "edit_reservation_expired",
    "edit_provider_calls",
    "pre_provider_edit_claim_has_call",
    "attempt_number = j.attempt_number + 1",
  ], "claim_edit_generation");
});

Deno.test("provider preparation is the at-most-once invocation gate", () => {
  const begin = functionSql("begin_edit_provider_call");
  includesAll(begin, [
    "where c.job_id = p_job_id",
    "return query select false, v_call.id",
    "edit_provider_call_conflict",
    "edit_provider_request_hash_mismatch",
    "insert into public.edit_provider_calls",
    "set status = 'provider_prepared'",
    "return query select true",
  ], "begin_edit_provider_call");
  assertOrdered(
    begin,
    "where c.job_id = p_job_id",
    "insert into public.edit_provider_calls",
    "existing call checked before insert",
  );
  assertOrdered(
    begin,
    "insert into public.edit_provider_calls",
    "return query select true",
    "provider ledger committed before authorization response",
  );
});

Deno.test("provider result capture validates deterministic storage and honest pricing", () => {
  const validator = functionSql("edit_provider_result_manifest_valid");
  includesAll(validator, [
    "edit-provider-result-v1",
    "edit_output_storage_path",
    "billingState",
    "pricingStatus",
    "is distinct from 'priced'",
    "is distinct from 'unpriced'",
  ], "provider result validator");
  const record = functionSql("record_edit_provider_result");
  includesAll(record, [
    "if v_call.status = 'succeeded' then",
    "edit_provider_result_conflict",
    "from storage.objects o",
    "status = 'succeeded'",
    "result_manifest = p_result_manifest",
    "status = 'result_captured'",
    "lease_token = null",
  ], "record_edit_provider_result");
  assertOrdered(
    record,
    "from storage.objects o",
    "update public.edit_provider_calls",
    "object existence before result capture",
  );
});

Deno.test("deterministic object recovery never invents known billing", () => {
  const recover = functionSql("recover_edit_provider_result");
  includesAll(recover, [
    "p_result_manifest ->> 'billingState' <> 'unknown'",
    "p_result_manifest -> 'costMicros' <> 'null'::jsonb",
    "recoveredFromDeterministicStorage",
    "v_job.status not in ('provider_prepared', 'indeterminate')",
    "from storage.objects o",
    "billing_state = 'unknown'",
    "cost_micros = null",
    "status = 'result_captured'",
  ], "recover_edit_provider_result");
});

Deno.test("failure transitions replay before CAS and release only definite outcomes", () => {
  const pre = functionSql("fail_edit_generation_pre_provider");
  includesAll(pre, [
    "if v_job.status = 'failed' then",
    "return query select true, true",
    "edit_pre_provider_failure_has_call",
    "state = 'released'",
    "status = 'failed'",
  ], "pre-provider failure");
  assertOrdered(pre, "if v_job.status = 'failed' then", "lease_expires_at <= now()", "pre-provider replay before CAS");

  const provider = functionSql("record_edit_provider_failure");
  includesAll(provider, [
    "if v_call.status <> 'prepared' then",
    "return query select true, true",
    "p_outcome = 'indeterminate'",
    "then 'unknown' else 'not_billable'",
    "then 'held' else 'released'",
  ], "provider failure");
  assertOrdered(provider, "if v_call.status <> 'prepared' then", "edit_generation_lease_lost", "terminal failure replay before CAS");
});

Deno.test("settlement atomically records delivery evidence and charges once", () => {
  const settle = functionSql("settle_edit_generation");
  includesAll(settle, [
    "if v_job.status = 'delivered' then",
    "return query select true, true",
    "v_job.status <> 'result_captured'",
    "from storage.objects o",
    "insert into public.taste_events",
    "'edit_generated'",
    "set state = 'charged'",
    "set status = 'delivered'",
  ], "settle_edit_generation");
  assertOrdered(settle, "if v_job.status = 'delivered' then", "v_job.status <> 'result_captured'", "delivery replay before active check");
  assertOrdered(settle, "insert into public.taste_events", "set state = 'charged'", "taste evidence before charge in one transaction");
  assertOrdered(settle, "set state = 'charged'", "set status = 'delivered'", "charge before delivery in one transaction");
});

Deno.test("indeterminate release is object-safe and stale work has a bounded reaper", () => {
  const release = functionSql("release_indeterminate_edit_generation");
  includesAll(release, [
    "v_job.status <> 'indeterminate'",
    "indeterminate_release_seconds",
    "edit_indeterminate_reconciliation_pending",
    "edit_output_storage_paths",
    "edit_cleanup_object_still_exists",
    "state = 'released'",
    "edit_indeterminate_released",
  ], "indeterminate release");
  const reaper = functionSql("reap_stale_edit_generation");
  includesAll(reaper, [
    "for update skip locked",
    "limit p_limit",
    "'pre_provider_requeued'",
    "'provider_outcome_indeterminate'",
    "status = 'indeterminate'",
    "billing_state = 'unknown'",
    "edit_output_storage_paths",
  ], "edit reaper");
});

Deno.test("direct mutation is denied and all lifecycle RPCs are service-only", () => {
  includesAll(sql, [
    "alter table public.edit_generation_jobs enable row level security",
    'create policy "edit generation jobs: owner read"',
    "revoke all on public.edit_provider_calls",
    "from public, anon, authenticated, service_role",
  ], "RLS and table privileges");
  for (const signature of [
    "reserve_edit_generation(uuid, text, jsonb)",
    "get_edit_generation_state(uuid, uuid)",
    "claim_edit_generation(uuid, uuid, uuid)",
    "settle_edit_generation(uuid, uuid, text, text)",
    "release_indeterminate_edit_generation(uuid, uuid)",
    "reap_stale_edit_generation(integer)",
  ]) {
    assert(sql.includes(`revoke all on function public.${signature}`), `missing revoke for ${signature}`);
    assert(sql.includes(`grant execute on function public.${signature}`), `missing service grant for ${signature}`);
  }
});
