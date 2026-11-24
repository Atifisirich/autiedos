/**
 * AI hooks of the ERP as an interface only (decision 40: Gemini is the only provider; Anthropic is gone).
 * The ERP used AI for four optional helpers (report-card remarks, question drafting, insights, exam analysis) and every one had
 * a non-AI fallback. The platform AI adapter (packages/server/src/adapters/ai.ts: credits, privacy filter, Gemini) implements this
 * interface on the server; the rule libraries here never call a provider. Callers must not put names or other personal data in a prompt.
 */
export interface ErpAiHook {
  /** Plain text answer, or null when AI is off, unavailable or blocked: callers then use their fallback. */
  text(system: string, user: string, opts?: { maxTokens?: number }): Promise<string | null>;
  /** JSON answer parsed defensively, or null. */
  json<T>(system: string, user: string, opts?: { maxTokens?: number }): Promise<T | null>;
}

/** The hook used when no provider is configured: always "no answer", so every feature falls back to its rule-based version. */
export const noAi: ErpAiHook = { text: async () => null, json: async () => null };
