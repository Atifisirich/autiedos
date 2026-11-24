-- DECISIONS #40: AI is Google Gemini only; Anthropic is removed. Models stay rows in platform_settings
-- (DECISIONS #19), now Gemini model IDs. The foundation migration is not edited; this replaces its row.
--
-- The IDs below are deliberately NAMED PLACEHOLDERS. They could not be verified against Google's
-- current model list when this was written (ai.google.dev was unreachable). The Gemini adapter
-- refuses placeholder IDs, so real AI cannot run until the platform admin sets real ones, e.g.:
--   update public.platform_settings set value = jsonb_build_object(
--     'strong', '<current Gemini Pro model id>', 'fast', '<current Gemini Flash model id>',
--     'prices', jsonb_build_object('strong', jsonb_build_object('input', <usd/1M>, 'output', <usd/1M>),
--                                  'fast',   jsonb_build_object('input', <usd/1M>, 'output', <usd/1M>)))
--   where key = 'ai_models';
-- Take IDs and PAID-tier prices from https://ai.google.dev/gemini-api/docs/models and /pricing.
-- 'prices' null means provider cost is recorded as 0 until prices are set.
-- Development and tests use the mock adapter, which ignores these values.
insert into public.platform_settings (key, value)
values ('ai_models', '{"strong":"PLACEHOLDER_GEMINI_STRONG_MODEL_ID","fast":"PLACEHOLDER_GEMINI_FAST_MODEL_ID","prices":null}'::jsonb)
on conflict (key) do update set value = excluded.value;
