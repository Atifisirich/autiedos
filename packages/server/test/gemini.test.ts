/**
 * Gemini adapter (DECISIONS #40) with fetch mocked: no network, no real key. The first group tests the
 * adapter alone; the second runs the real generate() pipeline against the test database to prove
 * validation + regeneration, "cost only on success" and the ledger rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asService, closePool, one, q } from '../src/db';
import { AiProviderError, AiRefusalError, GeminiProvider, assertAiConfig, geminiFromEnv, getAiProvider, setAiProvider, type AiModels, type AiRequest } from '../src/adapters/ai';
import { generate } from '../src/services/ai';

const MODELS: AiModels = { strong: 'test-strong-model', fast: 'test-fast-model', prices: { strong: { input: 2, output: 10 }, fast: { input: 0.1, output: 0.4 } } };
const REQ: AiRequest = { action: 'daily_plan', tier: 'strong', system: 'sys', prompt: 'hello', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } };

function ok(text: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25 }, modelVersion: 'test-strong-model-001', ...extra }), { status: 200 });
}
function err(status: number, message = 'nope') {
  return new Response(JSON.stringify({ error: { message, status: 'X' } }), { status });
}
const noSleep = async () => {};
function provider(fetchFn: ReturnType<typeof vi.fn>) {
  return new GeminiProvider({ apiKey: 'test-key-not-real', fetch: fetchFn as unknown as typeof fetch, sleep: noSleep });
}

afterEach(() => {
  vi.unstubAllEnvs();
  setAiProvider(null);
});

describe('gemini adapter', () => {
  it('sends a JSON-schema constrained request and parses valid JSON, tokens and cost', async () => {
    const f = vi.fn(async () => ok('{"answer":"42"}'));
    const res = await provider(f).generate(REQ, MODELS);
    expect(res.output).toEqual({ answer: '42' });
    expect(res.provider).toBe('gemini');
    expect(res.model).toBe('test-strong-model-001');
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(75); // candidates + thinking tokens
    expect(res.providerCost).toBeCloseTo((100 * 2 + 75 * 10) / 1e6, 8);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-strong-model:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key-not-real');
    expect(url).not.toContain('test-key-not-real'); // key is a header, never in the URL
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toEqual(REQ.schema);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.contents[0].parts[0].text).toBe('hello');
  });

  it('uses the fast model for the fast tier and skips thought parts', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"answer":"x"}' }] } }], usageMetadata: {} }), { status: 200 }));
    const res = await provider(f).generate({ ...REQ, tier: 'fast' }, MODELS);
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain('/models/test-fast-model:');
    expect(res.output).toEqual({ answer: 'x' });
    expect(res.providerCost).toBe(0);
  });

  it('returns null output for invalid JSON so the pipeline can regenerate', async () => {
    const res = await provider(vi.fn(async () => ok('not json {'))).generate(REQ, MODELS);
    expect(res.output).toBeNull();
  });

  it('retries 429 and 5xx then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(err(429)).mockResolvedValueOnce(err(503)).mockResolvedValueOnce(ok('{"answer":"ok"}'));
    const res = await provider(f).generate(REQ, MODELS);
    expect(f).toHaveBeenCalledTimes(3);
    expect(res.output).toEqual({ answer: 'ok' });
  });

  it('gives up after the retries on 429/5xx and does not retry other errors', async () => {
    const f = vi.fn(async () => err(429, 'quota'));
    await expect(provider(f).generate(REQ, MODELS)).rejects.toMatchObject({ status: 429 });
    expect(f).toHaveBeenCalledTimes(3);
    const f5 = vi.fn(async () => err(500));
    await expect(provider(f5).generate(REQ, MODELS)).rejects.toBeInstanceOf(AiProviderError);
    const f4 = vi.fn(async () => err(400, 'bad schema'));
    await expect(provider(f4).generate(REQ, MODELS)).rejects.toMatchObject({ status: 400 });
    expect(f4).toHaveBeenCalledTimes(1);
  });

  it('maps safety blocks to a refusal', async () => {
    const blocked = vi.fn(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }));
    await expect(provider(blocked).generate(REQ, MODELS)).rejects.toBeInstanceOf(AiRefusalError);
    const finish = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }), { status: 200 }));
    await expect(provider(finish).generate(REQ, MODELS)).rejects.toMatchObject({ category: 'PROHIBITED_CONTENT' });
  });

  it('refuses placeholder model IDs without calling the network', async () => {
    const f = vi.fn(async () => ok('{}'));
    await expect(provider(f).generate(REQ, { strong: 'PLACEHOLDER_GEMINI_STRONG_MODEL_ID', fast: 'x' })).rejects.toThrow(/not a real Gemini model ID/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('gemini configuration', () => {
  it('refuses to be built without a key', () => {
    expect(() => new GeminiProvider({ apiKey: '' })).toThrow(/GEMINI_API_KEY/);
  });

  it('production without a key is refused', () => {
    expect(() => geminiFromEnv({ NODE_ENV: 'production', GEMINI_TIER: 'paid' })).toThrow(/GEMINI_API_KEY is required in production/);
    expect(() => assertAiConfig({ NODE_ENV: 'production', GEMINI_TIER: 'paid' })).toThrow();
  });

  it('production on anything but the paid tier is refused', () => {
    expect(() => geminiFromEnv({ NODE_ENV: 'production', GEMINI_API_KEY: 'k' })).toThrow(/GEMINI_TIER=paid/);
    expect(() => geminiFromEnv({ NODE_ENV: 'production', GEMINI_API_KEY: 'k', GEMINI_TIER: 'free' })).toThrow(/GEMINI_TIER=paid/);
    expect(geminiFromEnv({ NODE_ENV: 'production', GEMINI_API_KEY: 'k', GEMINI_TIER: 'paid' }).name).toBe('gemini');
  });

  it('getAiProvider: mock in development and tests, Gemini in production or with a key', () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('NODE_ENV', 'test');
    expect(getAiProvider().name).toBe('mock');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getAiProvider()).toThrow(/GEMINI_API_KEY is required in production/);
    vi.stubEnv('GEMINI_API_KEY', 'k');
    expect(() => getAiProvider()).toThrow(/GEMINI_TIER=paid/);
    vi.stubEnv('GEMINI_TIER', 'paid');
    expect(getAiProvider().name).toBe('gemini');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('GEMINI_TIER', '');
    expect(getAiProvider().name).toBe('gemini'); // explicit key in development is allowed
  });
});

describe('gemini through the generation pipeline', () => {
  let org: string;
  let branch: string;
  let original: AiModels;
  const answer = z.object({ answer: z.string() });
  beforeAll(async () => {
    const r = await asService((c) => one<{ org_id: string; id: string }>(c, `select b.org_id, b.id from core.branches b join core.organizations o on o.id = b.org_id where o.slug = 'demo' and b.code = 'GACH'`));
    org = r.org_id;
    branch = r.id;
    // The seeded ai_models row holds named placeholders until real IDs are set (migration 20261124100000).
    const s = await asService((c) => one<{ value: AiModels }>(c, `select value from core.platform_settings where key = 'ai_models'`));
    expect(s.value.strong).toMatch(/PLACEHOLDER/);
    original = s.value;
    await asService((c) => c.query(`update core.platform_settings set value = $1 where key = 'ai_models'`, [JSON.stringify(MODELS)]));
  });
  afterAll(async () => {
    await asService((c) => c.query(`update core.platform_settings set value = $1 where key = 'ai_models'`, [JSON.stringify(original)]));
    await closePool();
  });

  const run = (extra: { prompt?: string } = {}) =>
    asService((c) =>
      generate(c, {
        orgId: org,
        branchId: branch,
        staffId: null,
        action: 'daily_plan',
        tier: 'strong',
        system: 'system',
        prompt: extra.prompt ?? 'Write a short answer.',
        jsonSchema: REQ.schema,
        zod: answer,
        validate: (o) => (o.answer.length < 3 ? ['too_short'] : []),
        repair: (o) => ({ answer: o.answer.trim() }),
        logInput: { test: 'gemini' },
      }),
    );
  const usage = () => asService((c) => one<{ n: number; total: number }>(c, `select count(*)::int as n, coalesce(sum(credits), 0) as total from public.ai_credit_ledger where kind = 'usage' and action = 'daily_plan' and branch_id = $1`, [branch]));

  it('invalid JSON then valid: regenerates, charges once, records a gemini generation', async () => {
    const f = vi.fn().mockResolvedValueOnce(ok('garbage')).mockResolvedValueOnce(ok('{"answer":"  fine  "}'));
    setAiProvider(provider(f));
    const before = await usage();
    const r = await run();
    expect(r.output).toEqual({ answer: 'fine' }); // repaired
    expect(r.attempts).toBe(2);
    expect(r.credits).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
    const retryPrompt = JSON.parse(((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).contents[0].parts[0].text as string;
    expect(retryPrompt).toContain('failed these checks');
    const gen = await asService((c) => one<{ status: string; provider: string; attempts: number; input_tokens: number; output_tokens: number; provider_cost: number; credits: number }>(c, `select * from core.ai_generations where id = $1`, [r.generationId]));
    expect(gen).toMatchObject({ status: 'ok', provider: 'gemini', attempts: 2, input_tokens: 200, output_tokens: 150, credits: 1 });
    expect(Number(gen.provider_cost)).toBeCloseTo((200 * 2 + 150 * 10) / 1e6, 8);
    const after = await usage();
    expect(after.n).toBe(before.n + 1);
    expect(Number(after.total)).toBe(Number(before.total) - 1);
  });

  it('three invalid answers cost nothing and are recorded as invalid', async () => {
    const f = vi.fn(async () => ok('{"answer":"x"}')); // fails the business check every time
    setAiProvider(provider(f));
    const before = await usage();
    await expect(run()).rejects.toMatchObject({ message: 'ai_output_invalid' });
    expect(f).toHaveBeenCalledTimes(3);
    expect((await usage()).n).toBe(before.n);
    const gen = await asService((c) => one<{ status: string; credits: number; attempts: number }>(c, `select status, credits, attempts from core.ai_generations where provider = 'gemini' and status = 'invalid' order by created_at desc limit 1`));
    expect(gen).toMatchObject({ status: 'invalid', credits: 0, attempts: 3 });
  });

  it('provider outage (429 after retries) costs nothing and is recorded as failed', async () => {
    const f = vi.fn(async () => err(429, 'quota exceeded'));
    setAiProvider(provider(f));
    const before = await usage();
    await expect(run()).rejects.toMatchObject({ message: 'ai_unavailable' });
    expect((await usage()).n).toBe(before.n);
    const gen = await asService((c) => one<{ status: string; credits: number; error: string }>(c, `select status, credits, error from core.ai_generations where provider = 'gemini' and status = 'failed' order by created_at desc limit 1`));
    expect(gen.credits).toBe(0);
    expect(gen.error).toContain('gemini_http_429');
  });

  it('a safety refusal costs nothing', async () => {
    setAiProvider(provider(vi.fn(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }))));
    const before = await usage();
    await expect(run()).rejects.toMatchObject({ message: 'ai_refused' });
    expect((await usage()).n).toBe(before.n);
  });

  it('the privacy filter blocks contact data before anything is sent to Gemini', async () => {
    const f = vi.fn(async () => ok('{"answer":"never"}'));
    setAiProvider(provider(f));
    const rows = () => asService((c) => q(c, `select 1 from core.ai_generations where provider = 'gemini'`));
    const before = (await rows()).length;
    await expect(run({ prompt: 'Contact the parent on 9876543210 about the plan.' })).rejects.toMatchObject({ message: 'personal_data_in_prompt' });
    await expect(run({ prompt: 'Email parent@example.com' })).rejects.toMatchObject({ message: 'personal_data_in_prompt' });
    expect(f).not.toHaveBeenCalled();
    expect((await rows()).length).toBe(before);
  });

  it('a missing production key fails the call and spends no credits', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GEMINI_API_KEY', '');
    const before = await usage();
    await expect(run()).rejects.toThrow(/GEMINI_API_KEY is required in production/);
    expect((await usage()).n).toBe(before.n);
  });
});
