/**
 * AI provider adapter (rule 7: server-side only). Google Gemini is the only real provider
 * (DECISIONS #40; Anthropic was removed). A deterministic mock behind the same interface keeps
 * every flow working in development and tests (PRD 1.3). Output is always structured JSON
 * validated by the caller (services/ai.ts: validate, repair, at most 3 attempts).
 *
 * Production safeguard: in production the Gemini provider is mandatory and refuses to be created
 * unless GEMINI_API_KEY is set and GEMINI_TIER=paid. Prompts sent on the free tier may be used by
 * Google to improve its models, which is not acceptable for school data.
 *
 * Gemini REST API references (official docs):
 *   - generateContent:  https://ai.google.dev/api/generate-content
 *   - structured output (generationConfig.responseMimeType + responseJsonSchema):
 *                       https://ai.google.dev/gemini-api/docs/structured-output
 *   - models and IDs:   https://ai.google.dev/gemini-api/docs/models
 *   - pricing and free vs paid data use: https://ai.google.dev/gemini-api/docs/pricing
 *                       and https://ai.google.dev/gemini-api/terms
 * NOTE: ai.google.dev could not be fetched when this was written (session network allow-list), so
 * the request/response shape below is from the documented v1beta API and has never been run
 * against the live service. See docs/adr/ai-gemini.md ("Unverified").
 */
import { mockGenerate } from './mockAi';

export type ModelTier = 'strong' | 'fast';

export interface AiRequest {
  action: string;
  tier: ModelTier;
  system: string;
  prompt: string;
  /** JSON schema for the structured output */
  schema: Record<string, unknown>;
  /** Context the mock provider uses to build a realistic answer (never sent anywhere). */
  mockContext?: Record<string, unknown>;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

export interface AiResult {
  output: unknown;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  providerCost: number;
}

export class AiRefusalError extends Error {
  status = 422;
  constructor(public category: string | null) {
    super('ai_refused');
  }
}

/** Thrown for provider outages, rate limits and bad responses. `status` is the HTTP status when there was one. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    public status: number | null = null,
  ) {
    super(message);
  }
}

/** USD per million tokens, per tier. Stored with the model IDs in platform_settings.ai_models. */
export interface ModelPrices {
  strong?: { input: number; output: number } | null;
  fast?: { input: number; output: number } | null;
}

export interface AiModels {
  strong: string;
  fast: string;
  prices?: ModelPrices | null;
}

export interface AiProvider {
  name: string;
  generate(req: AiRequest, models: AiModels): Promise<AiResult>;
}

/** Provider cost in USD for one call. Unknown prices record 0 rather than a made-up number. */
export function providerCost(price: { input: number; output: number } | null | undefined, input: number, output: number): number {
  if (!price) return 0;
  return Math.round(((input * price.input + output * price.output) / 1_000_000) * 1_000_000) / 1_000_000;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Finish reasons that mean Gemini declined to answer (not an outage). */
const GEMINI_REFUSAL_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'RECITATION']);
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const PLACEHOLDER_MODEL = /placeholder|to[-_]?verify|replace/i;

export interface GeminiOptions {
  apiKey: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Extra attempts for 429 / 5xx / network errors (default 2). */
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  error?: { message?: string; status?: string };
}

export class GeminiProvider implements AiProvider {
  name = 'gemini';
  private apiKey: string;
  private doFetch: typeof fetch;
  private base: string;
  private maxRetries: number;
  private timeoutMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(o: GeminiOptions) {
    if (!o.apiKey) throw new Error('GEMINI_API_KEY is required for the Gemini provider');
    this.apiKey = o.apiKey;
    this.doFetch = o.fetch ?? ((...a) => fetch(...a));
    this.base = o.baseUrl ?? GEMINI_BASE;
    this.maxRetries = o.maxRetries ?? 2;
    this.timeoutMs = o.timeoutMs ?? 120_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async generate(req: AiRequest, models: AiModels): Promise<AiResult> {
    const model = (req.tier === 'strong' ? models.strong : models.fast).replace(/^models\//, '');
    if (!model || PLACEHOLDER_MODEL.test(model) || !/^[A-Za-z0-9._-]+$/.test(model)) {
      throw new AiProviderError(`ai_models setting for "${req.tier}" is not a real Gemini model ID (${model || 'empty'}); set it in platform_settings`);
    }
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: req.schema,
        maxOutputTokens: req.maxTokens ?? 16000,
      },
    };
    const json = await this.post(`${this.base}/models/${model}:generateContent`, body);

    if (json.promptFeedback?.blockReason) throw new AiRefusalError(json.promptFeedback.blockReason);
    const cand = json.candidates?.[0];
    if (!cand) throw new AiProviderError('gemini_empty_response');
    if (cand.finishReason && GEMINI_REFUSAL_FINISH.has(cand.finishReason)) throw new AiRefusalError(cand.finishReason);
    // Thinking models can return thought parts; only the answer parts hold the JSON.
    const text = (cand.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      output = null; // the pipeline regenerates (up to 3 attempts) and records the failure
    }
    const u = json.usageMetadata ?? {};
    const inputTokens = u.promptTokenCount ?? 0;
    // Thinking tokens are billed as output tokens.
    const outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    const price = req.tier === 'strong' ? models.prices?.strong : models.prices?.fast;
    return { output, model: json.modelVersion || model, provider: this.name, inputTokens, outputTokens, providerCost: providerCost(price, inputTokens, outputTokens) };
  }

  private async post(url: string, body: unknown): Promise<GeminiResponse> {
    let lastErr: AiProviderError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      let res: Response;
      try {
        res = await this.doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastErr = new AiProviderError(`gemini_network: ${(e as Error).name}`);
        continue;
      }
      if (res.ok) {
        try {
          return (await res.json()) as GeminiResponse;
        } catch {
          throw new AiProviderError('gemini_bad_json_envelope', res.status);
        }
      }
      let detail = '';
      try {
        detail = ((await res.json()) as GeminiResponse).error?.message ?? '';
      } catch {
        /* non-JSON error body */
      }
      lastErr = new AiProviderError(`gemini_http_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status);
      if (!RETRYABLE.has(res.status)) throw lastErr;
    }
    throw lastErr ?? new AiProviderError('gemini_failed');
  }
}

/**
 * Builds the Gemini provider from the environment. In production it refuses unless the key is set
 * and GEMINI_TIER=paid (free-tier prompts may be used by Google to improve models).
 */
let warnedFreeTier = false;
export function geminiFromEnv(env: Record<string, string | undefined> = process.env): GeminiProvider {
  const key = env.GEMINI_API_KEY?.trim();
  if (env.NODE_ENV === 'production') {
    if (!key) throw new Error('GEMINI_API_KEY is required in production');
    // Decision 60: the owner accepted the free tier for now. It must be stated explicitly (two variables), and is
    // logged, because free-tier prompts may be used by Google to improve its models. Personal data is still stripped.
    const freeAccepted = env.GEMINI_TIER === 'free' && env.GEMINI_FREE_TIER_ACK === 'owner-accepted';
    if (env.GEMINI_TIER !== 'paid' && !freeAccepted) throw new Error('GEMINI_TIER=paid is required in production (or GEMINI_TIER=free with GEMINI_FREE_TIER_ACK=owner-accepted): the free Gemini tier may use prompts to improve Google models');
    if (freeAccepted && !warnedFreeTier) { warnedFreeTier = true; console.warn('[ai] Gemini FREE tier in use (decision 60): prompts may be used by Google; switch to a paid key before real school data.'); }
  }
  return new GeminiProvider({ apiKey: key ?? '' });
}

/** Call at server start-up (e.g. a deployment health check) to fail fast on a bad production AI config. */
export function assertAiConfig(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV === 'production') geminiFromEnv(env);
}

class MockProvider implements AiProvider {
  name = 'mock';
  async generate(req: AiRequest): Promise<AiResult> {
    const output = mockGenerate(req.action, req.mockContext ?? {});
    const inputTokens = Math.ceil((req.system.length + req.prompt.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(output).length / 4);
    return { output, model: 'mock', provider: this.name, inputTokens, outputTokens, providerCost: 0 };
  }
}

let override: AiProvider | null = null;

/** Tests can inject a provider. */
export function setAiProvider(p: AiProvider | null) {
  override = p;
}

/**
 * Production: always Gemini (throws if not configured as above). Development and tests: Gemini only
 * when GEMINI_API_KEY is set explicitly, otherwise the deterministic mock.
 */
export function getAiProvider(): AiProvider {
  if (override) return override;
  if (process.env.NODE_ENV === 'production' || process.env.GEMINI_API_KEY) return geminiFromEnv();
  return new MockProvider();
}
