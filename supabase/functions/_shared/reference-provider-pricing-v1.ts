export const REFERENCE_VISION_PRICING_VERSION = "env-rate-v1" as const;

export type ReferenceProviderPricingV1 =
  | {
    readonly costMicros: number;
    readonly pricingStatus: "priced";
    readonly pricingVersion: typeof REFERENCE_VISION_PRICING_VERSION;
  }
  | {
    readonly costMicros: 0;
    readonly pricingStatus: "unpriced";
    readonly pricingVersion: null;
    readonly unpricedReason: "rate_config_missing_or_invalid";
  };

function configuredRate(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(value)
    ? value
    : null;
}

/**
 * Prices a completed reference-vision call without inventing a zero charge.
 * Both rate values are micro-USD per million tokens. Missing/invalid pricing
 * leaves usage durable but explicitly unpriced for later reconciliation.
 */
export function priceReferenceVisionUsageV1(input: {
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly inputMicroUsdPerMillion: string | undefined;
  readonly outputMicroUsdPerMillion: string | undefined;
}): ReferenceProviderPricingV1 {
  if (
    !Number.isSafeInteger(input.inputUnits) || input.inputUnits < 0 ||
    !Number.isSafeInteger(input.outputUnits) || input.outputUnits < 0
  ) {
    throw new TypeError("reference_usage_units_invalid");
  }
  const inputRate = configuredRate(input.inputMicroUsdPerMillion);
  const outputRate = configuredRate(input.outputMicroUsdPerMillion);
  if (inputRate === null || outputRate === null) {
    return {
      costMicros: 0,
      pricingStatus: "unpriced",
      pricingVersion: null,
      unpricedReason: "rate_config_missing_or_invalid",
    };
  }
  const costMicros = Math.ceil(
    (input.inputUnits * inputRate + input.outputUnits * outputRate) / 1_000_000,
  );
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
    return {
      costMicros: 0,
      pricingStatus: "unpriced",
      pricingVersion: null,
      unpricedReason: "rate_config_missing_or_invalid",
    };
  }
  return {
    costMicros,
    pricingStatus: "priced",
    pricingVersion: REFERENCE_VISION_PRICING_VERSION,
  };
}
