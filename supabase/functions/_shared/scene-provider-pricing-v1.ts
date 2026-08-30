export const SCENE_PROVIDER_PRICING_VERSION = "2026-08-28" as const;

function nonnegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function tokenCostMicros(tokens: number, usdPerMillion: number): number {
  // One USD contains one million micro-USD, so USD-per-million-tokens maps
  // directly to micro-USD per token.
  return Math.ceil(tokens * usdPerMillion);
}

export function sceneProviderCost(input: {
  model: string;
  imageSize: "1K" | "2K" | "4K";
  usageMetadata?: Record<string, unknown> | null;
}): {
  costMicros: number;
  inputUnits: number;
  outputUnits: number;
  pricingVersion: typeof SCENE_PROVIDER_PRICING_VERSION;
  components: Record<string, number>;
} {
  const usage = input.usageMetadata ?? {};
  const promptTokens = nonnegativeInteger(usage.promptTokenCount);
  const thoughtTokens = nonnegativeInteger(usage.thoughtsTokenCount);
  const outputUnits = nonnegativeInteger(usage.candidatesTokenCount);
  const normalizedModel = input.model.replace(/-preview$/, "");

  let imageMicros: number;
  let inputUsdPerMillion: number;
  let thoughtUsdPerMillion: number;
  if (normalizedModel === "gemini-3.1-flash-image") {
    imageMicros = input.imageSize === "1K"
      ? 67_000
      : input.imageSize === "2K"
      ? 101_000
      : 151_000;
    inputUsdPerMillion = 0.5;
    thoughtUsdPerMillion = 3;
  } else if (normalizedModel === "gemini-3-pro-image") {
    imageMicros = input.imageSize === "4K" ? 240_000 : 134_000;
    inputUsdPerMillion = 2;
    thoughtUsdPerMillion = 12;
  } else if (
    normalizedModel === "gemini-2.5-flash-image" ||
    normalizedModel === "gemini-2.5-flash-image-preview"
  ) {
    imageMicros = 39_000;
    inputUsdPerMillion = 0.3;
    thoughtUsdPerMillion = 0;
  } else {
    throw new Error(`unpriced_scene_provider_model:${input.model}`);
  }

  const inputMicros = tokenCostMicros(promptTokens, inputUsdPerMillion);
  const thoughtMicros = tokenCostMicros(
    thoughtTokens,
    thoughtUsdPerMillion,
  );
  return {
    costMicros: imageMicros + inputMicros + thoughtMicros,
    inputUnits: promptTokens,
    outputUnits,
    pricingVersion: SCENE_PROVIDER_PRICING_VERSION,
    components: { imageMicros, inputMicros, thoughtMicros },
  };
}
