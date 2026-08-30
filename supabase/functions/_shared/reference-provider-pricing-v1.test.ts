import { priceReferenceVisionUsageV1 } from "./reference-provider-pricing-v1.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("configured rates produce a reported price, including a real zero", () => {
  assertEquals(
    priceReferenceVisionUsageV1({
      inputUnits: 1_000_000,
      outputUnits: 500_000,
      inputMicroUsdPerMillion: "100",
      outputMicroUsdPerMillion: "400",
    }),
    {
      costMicros: 300,
      pricingStatus: "priced",
      pricingVersion: "env-rate-v1",
    },
  );
  assertEquals(
    priceReferenceVisionUsageV1({
      inputUnits: 0,
      outputUnits: 0,
      inputMicroUsdPerMillion: "100",
      outputMicroUsdPerMillion: "400",
    }),
    {
      costMicros: 0,
      pricingStatus: "priced",
      pricingVersion: "env-rate-v1",
    },
  );
});

Deno.test("missing or invalid rate configuration is explicitly unpriced", () => {
  const unpriced = {
    costMicros: 0,
    pricingStatus: "unpriced",
    pricingVersion: null,
    unpricedReason: "rate_config_missing_or_invalid",
  };
  assertEquals(
    priceReferenceVisionUsageV1({
      inputUnits: 10,
      outputUnits: 5,
      inputMicroUsdPerMillion: undefined,
      outputMicroUsdPerMillion: "400",
    }),
    unpriced,
  );
  assertEquals(
    priceReferenceVisionUsageV1({
      inputUnits: 10,
      outputUnits: 5,
      inputMicroUsdPerMillion: "100",
      outputMicroUsdPerMillion: "not-a-number",
    }),
    unpriced,
  );
});

Deno.test("negative or fractional usage is rejected", () => {
  for (const inputUnits of [-1, 0.5]) {
    try {
      priceReferenceVisionUsageV1({
        inputUnits,
        outputUnits: 0,
        inputMicroUsdPerMillion: "100",
        outputMicroUsdPerMillion: "400",
      });
    } catch (error) {
      assertEquals((error as Error).message, "reference_usage_units_invalid");
      continue;
    }
    throw new Error("expected invalid usage rejection");
  }
});
