# ADR: AI provider is Google Gemini only

Status: accepted (owner decision, DECISIONS #40, Q15). Supersedes the Anthropic parts of DECISIONS #19.

## Decision

* Gemini is the only real AI provider. The Anthropic adapter and the `@anthropic-ai/sdk` dependency are removed; there
  are no `ANTHROPIC_*` variables.
* The adapter (`packages/server/src/adapters/ai.ts`) calls the Gemini REST API with `fetch` (no SDK): one POST to
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, key in the `x-goog-api-key` header.
* Structured output: `generationConfig.responseMimeType = application/json` plus `responseJsonSchema` (the JSON schemas
  the services already pass). The caller still validates with zod, applies deterministic repair and business checks,
  and regenerates up to 3 attempts (`services/ai.ts`, unchanged contract).
* Development and tests use the deterministic mock (`mockAi.ts`). The mock is used unless `GEMINI_API_KEY` is set
  outside production.

## Production safeguard

Free-tier prompts can be used by Google to improve its models. That is not acceptable for school data, so in
production (`NODE_ENV=production`) the provider is always Gemini and **refuses to be created** unless both
`GEMINI_API_KEY` is set and `GEMINI_TIER=paid`. There is no mock fallback in production: a missing or non-paid
config fails the AI call (and `assertAiConfig()` is exported for a start-up or health check). `GEMINI_TIER` is a
declaration by whoever deploys; the adapter cannot verify billing, so the key must really be on a billing-enabled
project. Privacy rules are unchanged (DECISIONS #9): the contact-data filter runs before any provider call and the
roster-name filter stays in the services.

## Models and prices

Models stay rows in `platform_settings` (key `ai_models`: `strong`, `fast`, optional `prices`
`{strong:{input,output}, fast:{input,output}}` in USD per 1M tokens). Migration `20261124100000_gemini_settings.sql`
replaces the old Claude row. Unknown prices record provider cost 0 instead of a guess. Thinking tokens are counted as
output tokens (they are billed as such).

**The model IDs are named placeholders** (`PLACEHOLDER_GEMINI_STRONG_MODEL_ID` / `..._FAST_...`) and the adapter
refuses them with a clear error. They could not be verified: when this was written `ai.google.dev` was blocked by the
session network allow-list, and web search only returned third-party pages that disagreed (results mentioned
`gemini-2.5-pro` / `gemini-2.5-flash` as stable IDs with a retirement date that moved, and several newer 3.x names).
Before go-live, an owner must take the current Pro-class (strong) and Flash-class (fast) IDs and **paid-tier** prices from
<https://ai.google.dev/gemini-api/docs/models> and <https://ai.google.dev/gemini-api/docs/pricing> and update the row
(SQL example in the migration header).

## Failure behaviour (credits)

* Provider unavailable (429/500/502/503/504 retried twice with backoff; other 4xx not retried), safety refusal
  (`promptFeedback.blockReason`, or finish reason SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII, RECITATION), invalid
  output after 3 attempts, privacy block, credit block: no credits charged (DECISIONS #18).
* Credits are charged, and the `ai_credit_ledger` usage row written, only when the final output passes validation.
* Every call that reaches the pipeline is recorded in `ai_generations` (`ok`, `invalid`, `failed`, `blocked`). Fix made
  alongside this change: `invalid`, `failed` and `blocked` rows used to be written inside the request transaction that
  is rolled back when the error is thrown, so they were lost. They are now written on their own connection
  (`recordFailed` in `services/ai.ts`). Contact-data privacy blocks throw before a row exists, as before.

## Unverified (never run against the live service)

* Exact request/response field names (`responseJsonSchema`, `systemInstruction`, `usageMetadata.thoughtsTokenCount`,
  `modelVersion`, `promptFeedback.blockReason`) are from memory of the documented v1beta API; unit tests use mocked
  `fetch` only.
* Which JSON-schema keywords the chosen models accept in `responseJsonSchema` (our schemas use `type`, `properties`,
  `required`, `items`, `enum`, `additionalProperties: false`).
* No thinking-level or effort setting is sent (`AiRequest.effort` is currently ignored for Gemini); the field names differ
  between model generations. Tune once real IDs are chosen. Large thinking budgets consume `maxOutputTokens` (default 16000).
* Run a live smoke test with a paid-tier key before release (HANDOFF section on real-service integration tests).
