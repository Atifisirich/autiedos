/**
 * AI provider adapter (rule 7: server-side only). The Anthropic adapter is used when
 * ANTHROPIC_API_KEY is set; otherwise a deterministic mock behind the same interface keeps
 * every flow working (PRD 1.3). Output is always structured JSON validated by the caller.
 */
import Anthropic from '@anthropic-ai/sdk';
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

export interface AiProvider {
  name: string;
  generate(req: AiRequest, models: { strong: string; fast: string }): Promise<AiResult>;
}

/** USD per million tokens (input, output). Used to record provider cost against credits sold. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export function providerCost(model: string, input: number, output: number): number {
  const p = PRICES[model] ?? [4, 20];
  return Math.round(((input * p[0] + output * p[1]) / 1_000_000) * 1_000_000) / 1_000_000;
}

class AnthropicProvider implements AiProvider {
  name = 'anthropic';
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }
  async generate(req: AiRequest, models: { strong: string; fast: string }): Promise<AiResult> {
    const model = req.tier === 'strong' ? models.strong : models.fast;
    const response = await this.client.beta.messages.create({
      model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { format: { type: 'json_schema', schema: req.schema }, effort: req.effort ?? (req.tier === 'strong' ? 'medium' : 'low') },
      // Server-side refusal fallback: routes a declined request to a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (response.stop_reason === 'refusal') throw new AiRefusalError(response.stop_details?.category ?? null);
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      output = null;
    }
    const inputTokens = response.usage.input_tokens ?? 0;
    const outputTokens = response.usage.output_tokens ?? 0;
    return { output, model: response.model, provider: this.name, inputTokens, outputTokens, providerCost: providerCost(response.model, inputTokens, outputTokens) };
  }
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

export function getAiProvider(): AiProvider {
  if (override) return override;
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? new AnthropicProvider(key) : new MockProvider();
}
