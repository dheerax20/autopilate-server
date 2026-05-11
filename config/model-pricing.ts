// =============================================================================
// Model Pricing Configuration
// Reads from environment variables so pricing can be updated without code changes.
// Defaults reflect Anthropic pricing as of 2025-05.
// =============================================================================

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

function parseFloat(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = Number(envVar);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Per-model pricing in USD per 1M tokens. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: {
    inputPer1M: parseFloat(process.env.PRICING_OPUS_INPUT_PER_1M, 15),
    outputPer1M: parseFloat(process.env.PRICING_OPUS_OUTPUT_PER_1M, 75),
  },
  sonnet: {
    inputPer1M: parseFloat(process.env.PRICING_SONNET_INPUT_PER_1M, 3),
    outputPer1M: parseFloat(process.env.PRICING_SONNET_OUTPUT_PER_1M, 15),
  },
  haiku: {
    inputPer1M: parseFloat(process.env.PRICING_HAIKU_INPUT_PER_1M, 0.25),
    outputPer1M: parseFloat(process.env.PRICING_HAIKU_OUTPUT_PER_1M, 1.25),
  },
};

/** Rough per-node cost estimate (used by configuration-analyzer). */
export const COST_PER_NODE_ESTIMATE: number = parseFloat(
  process.env.PRICING_COST_PER_NODE_ESTIMATE,
  0.15
);

/**
 * Look up pricing for a model string like "claude-3-opus-20240229".
 * Falls back to sonnet pricing if the model name doesn't match a known tier.
 */
export function getPricingForModel(model: string): ModelPricing {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return MODEL_PRICING.opus;
  if (lower.includes('haiku')) return MODEL_PRICING.haiku;
  return MODEL_PRICING.sonnet;
}
