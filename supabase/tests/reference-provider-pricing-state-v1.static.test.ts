const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260829025000_reference_provider_pricing_state_v1.sql",
    import.meta.url,
  ),
);
const handler = await Deno.readTextFile(
  new URL(
    "../functions/index-references/index.ts",
    import.meta.url,
  ),
);

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

Deno.test("handler marks missing vision pricing as explicit unpriced evidence", () => {
  assertIncludesAll(handler, [
    "priceReferenceVisionUsageV1({",
    "REFERENCE_VISION_INPUT_MICROUSD_PER_M_TOKEN",
    "REFERENCE_VISION_OUTPUT_MICROUSD_PER_M_TOKEN",
    "pricingStatus: pricing.pricingStatus",
    "pricingVersion: pricing.pricingVersion",
    "unpricedReason: pricing.unpricedReason",
    "costMicros: pricing.costMicros",
  ], "vision ledger");
  assert(
    !handler.includes('Deno.env.get(name) ?? "0"'),
    "missing pricing must not default to zero",
  );
  assert(
    (handler.match(/pricingStatus:/g) ?? []).length === 3,
    "every vision/text/visual provider result must declare pricing status",
  );
});

Deno.test("SQL derives unknown billing and NULL cost for unpriced results", () => {
  assertIncludesAll(migration, [
    "coalesce(v_pricing_status, '') not in ('priced', 'unpriced')",
    "unpriced_provider_result_has_cost",
    "v_billing_state := 'unknown'",
    "v_effective_cost_micros := null",
    "billing_state = v_billing_state",
    "cost_micros = v_effective_cost_micros",
  ], "unpriced SQL contract");
});

Deno.test("a real configured zero remains distinctly reported", () => {
  assertIncludesAll(migration, [
    "v_billing_state := 'reported'",
    "v_effective_cost_micros := coalesce(p_cost_micros, 0)",
  ], "priced SQL contract");
});

Deno.test("idempotent result replay binds the complete billing ledger", () => {
  const replayStart = migration.indexOf("if v_call.status = 'succeeded' then");
  const activeStart = migration.indexOf("if v_call.status <> 'prepared'");
  assert(
    replayStart >= 0 && activeStart > replayStart,
    "terminal replay must precede active lease validation",
  );
  const replay = migration.slice(replayStart, activeStart);
  assertIncludesAll(replay, [
    "v_call.response_hash <> v_response_hash",
    "v_call.input_units is distinct from v_input_units",
    "v_call.output_units is distinct from v_output_units",
    "v_call.cost_micros is distinct from v_effective_cost_micros",
    "v_call.billing_state is distinct from v_billing_state",
    "v_call.provider_meta is distinct from v_provider_meta",
    "provider_result_conflict",
  ], "provider result replay");
});

Deno.test("provider result staging remains service-role only", () => {
  assertIncludesAll(migration, [
    "revoke all on function public.record_reference_index_provider_result(",
    ") from public, anon, authenticated",
    "grant execute on function public.record_reference_index_provider_result(",
    ") to service_role",
  ], "provider result privileges");
});
