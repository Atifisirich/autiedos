-- DECISIONS #40: AI is Google Gemini only; Anthropic is removed. Models stay rows in the platform settings
-- (DECISIONS #19), now Gemini model IDs. Since the OS move the settings live in core.platform_settings
-- (global row: org_id null; an org row overrides it). This replaces the global row.
--
-- The IDs below are deliberately NAMED PLACEHOLDERS. They could not be verified against Google's
-- current model list when this was written (ai.google.dev was unreachable). The Gemini adapter
-- refuses placeholder IDs, so real AI cannot run until the platform admin sets real ones, e.g.:
--   update core.platform_settings set value = jsonb_build_object(
--     'strong', '<current Gemini Pro model id>', 'fast', '<current Gemini Flash model id>',
--     'prices', jsonb_build_object('strong', jsonb_build_object('input', <usd/1M>, 'output', <usd/1M>),
--                                  'fast',   jsonb_build_object('input', <usd/1M>, 'output', <usd/1M>)))
--   where org_id is null and key = 'ai_models';
-- Take IDs and PAID-tier prices from https://ai.google.dev/gemini-api/docs/models and /pricing.
-- 'prices' null means provider cost is recorded as 0 until prices are set.
-- Development and tests use the mock adapter, which ignores these values.
insert into core.platform_settings (org_id, key, value)
values (null, 'ai_models', '{"strong":"PLACEHOLDER_GEMINI_STRONG_MODEL_ID","fast":"PLACEHOLDER_GEMINI_FAST_MODEL_ID","prices":null}'::jsonb)
on conflict (org_id, key) do update set value = excluded.value;
