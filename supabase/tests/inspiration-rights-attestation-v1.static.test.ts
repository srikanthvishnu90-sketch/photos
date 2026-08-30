const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260829024000_inspiration_rights_attestations_v1.sql",
    import.meta.url,
  ),
);
const priorGenerationMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20260829022000_generation_accepted_output_v1.sql",
    import.meta.url,
  ),
);
const indexHandler = await Deno.readTextFile(
  new URL(
    "../functions/index-references/index.ts",
    import.meta.url,
  ),
);
const generationHandler = await Deno.readTextFile(
  new URL(
    "../functions/generate-scene/index.ts",
    import.meta.url,
  ),
);
const requestHandler = indexHandler.slice(indexHandler.indexOf("Deno.serve"));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertIncludesAll(
  source: string,
  anchors: readonly string[],
  scope: string,
) {
  for (const anchor of anchors) {
    assert(source.includes(anchor), `${scope} is missing: ${anchor}`);
  }
}

function assertOrdered(
  source: string,
  earlier: string,
  later: string,
  message: string,
) {
  const earlierAt = source.indexOf(earlier);
  const laterAt = source.indexOf(later);
  assert(earlierAt >= 0, `missing earlier anchor: ${earlier}`);
  assert(laterAt >= 0, `missing later anchor: ${later}`);
  assert(earlierAt < laterAt, message);
}

function functionSql(name: string): string {
  return functionSqlFrom(migration, name);
}

function functionSqlFrom(source: string, name: string): string {
  const marker = `create or replace function public.${name}(`;
  const start = source.indexOf(marker);
  const end = source.indexOf("\n$$;", start);
  assert(start >= 0, `missing function ${name}`);
  assert(end > start, `unterminated function ${name}`);
  return source.slice(start, end + 4);
}

Deno.test("rights evidence is append-only, owner-readable, and service-written", () => {
  assertIncludesAll(migration, [
    "create table if not exists public.inspiration_rights_attestations",
    "foreign key (asset_id, profile_id)",
    "references public.inspiration_assets(id, profile_id)",
    "on delete cascade",
    "enable row level security",
    "(select auth.uid()) = profile_id",
    "revoke all on public.inspiration_rights_attestations",
    "from public, anon, authenticated, service_role",
    "grant select on public.inspiration_rights_attestations to authenticated",
  ], "rights evidence table");
  assert(
    !/grant\s+(insert|update|delete|all)\s+on\s+public\.inspiration_rights_attestations/i
      .test(migration),
    "audit evidence must expose no direct mutation grant",
  );
});

Deno.test("attestation transaction validates the whole batch before writes", () => {
  const rpc = functionSql("attest_inspiration_asset_rights");
  assertIncludesAll(rpc, [
    "rightsBasis",
    "('owned', 'licensed')",
    "conditioningAuthorized",
    "'conditioning-rights-v1'",
    "inspiration_rights_attestations_not_canonical",
    "pg_catalog.pg_advisory_xact_lock",
    "for update;",
    "inspiration_rights_attestation_forbidden",
    "inspiration_rights_basis_conflict",
    "set rights = v_item ->> 'rightsBasis'",
    "usable_for_conditioning = true",
    "insert into public.inspiration_rights_attestations",
  ], "attestation RPC");
  assertOrdered(
    rpc,
    "-- Validate and lock the entire batch",
    "set rights = v_item ->> 'rightsBasis'",
    "asset validation and locks must precede eligibility writes",
  );
});

Deno.test("attestation replay is hash-bound and precedes mutation", () => {
  const rpc = functionSql("attest_inspiration_asset_rights");
  assertIncludesAll(rpc, [
    "v_request_hash := encode(",
    "v_existing_min_hash is distinct from v_request_hash",
    "v_existing_max_hash is distinct from v_request_hash",
    "inspiration_rights_attestation_idempotency_conflict",
    "true,",
  ], "attestation idempotency");
  assertOrdered(
    rpc,
    "if v_existing_count > 0 then",
    "-- Validate and lock the entire batch",
    "idempotent replay must precede new mutation",
  );
});

Deno.test("attestation RPC is callable only by service_role", () => {
  assertIncludesAll(migration, [
    "revoke all on function public.attest_inspiration_asset_rights(uuid, text, jsonb)",
    "from public, anon, authenticated",
    "grant execute on function public.attest_inspiration_asset_rights(",
    ") to service_role",
  ], "attestation privileges");
});

Deno.test("index handler attests before lookup and candidate eligibility filtering", () => {
  assertIncludesAll(requestHandler, [
    "rightsAttestations?: unknown",
    "parseReferenceRightsAttestationsV1(",
    "rights_attestation_batch_id_required",
    "idempotencyKey: `${batchId}:rights`",
    "rights_attestation_forbidden",
    "rights_attestation_conflict",
    "rightsAttested",
  ], "index handler rights contract");
  assertOrdered(
    requestHandler,
    "await attestInspirationAssetRightsV1",
    "await reapStaleReferenceIndexWork",
    "rights assertion must precede indexing lifecycle work",
  );
  assertOrdered(
    requestHandler,
    "await attestInspirationAssetRightsV1",
    'let query = supabase.from("inspiration_assets")',
    "rights assertion must precede eligibility query",
  );
});

Deno.test("generation accepts attested owned and licensed owner uploads", () => {
  assert(
    generationHandler.includes('["owned", "licensed"].includes(row.rights)'),
    "Edge generation gate does not accept both attested owner bases",
  );
  const snapshot = functionSql("record_scene_fixed_reference_snapshot");
  assert(
    snapshot.includes("v_asset.rights in ('owned', 'licensed')"),
    "database provenance gate does not accept both attested owner bases",
  );
  assert(
    snapshot.includes("v_asset.profile_id is null") &&
      snapshot.includes("v_asset.source = 'style_pack'") &&
      snapshot.includes("v_asset.rights = 'licensed'"),
    "style-pack license gate was weakened",
  );
  const prior = functionSqlFrom(
    priorGenerationMigration,
    "record_scene_fixed_reference_snapshot",
  );
  assert(
    snapshot === prior.replace(
      "v_asset.rights = 'owned'",
      "v_asset.rights in ('owned', 'licensed')",
    ),
    "forward snapshot RPC replacement changed more than the owner rights basis",
  );
});
