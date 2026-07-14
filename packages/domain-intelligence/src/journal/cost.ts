/**
 * Model cost accounting. Prices are USD per million tokens, as published by
 * Groq (checked 2026-07; update deliberately, the journal stores computed
 * cost at write time so historical rows never re-price).
 * Unknown models cost null — never a silent zero, an unknown is an unknown.
 */

interface ModelPrice {
    inputPerMTok: number;
    outputPerMTok: number;
}

const GROQ_PRICES: Record<string, ModelPrice> = {
    "llama-3.3-70b-versatile": { inputPerMTok: 0.59, outputPerMTok: 0.79 },
    "llama-3.1-8b-instant": { inputPerMTok: 0.05, outputPerMTok: 0.08 },
};

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
}

export const modelCostUsd = (modelId: string, usage: TokenUsage | null): number | null => {
    if (!usage) return null;
    const price = GROQ_PRICES[modelId];
    if (!price) return null;
    if (usage.promptTokens < 0 || usage.completionTokens < 0) return null;
    const cost =
        (usage.promptTokens / 1_000_000) * price.inputPerMTok +
        (usage.completionTokens / 1_000_000) * price.outputPerMTok;
    return Math.round(cost * 1_000_000) / 1_000_000; // journal column: NUMERIC(10,6)
};

export const KNOWN_MODELS = Object.keys(GROQ_PRICES);
