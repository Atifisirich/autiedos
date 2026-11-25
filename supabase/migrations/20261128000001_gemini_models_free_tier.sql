-- Decision 60: real Gemini model ids (checked against the owner's key's model list on 2026-11-25).
-- The free tier has no quota for Pro models (limit 0), so both slots use Flash-class models until the key is paid;
-- then set strong to 'gemini-pro-latest' in core.platform_settings (no code change).
insert into core.platform_settings (org_id, key, value)
values (null, 'ai_models', '{"strong":"gemini-flash-latest","fast":"gemini-flash-lite-latest","prices":null}'::jsonb)
on conflict (org_id, key) do update set value = excluded.value;
