/**
 * AI help bot (PRD 8.6): answers only from the knowledge base (AutoEd articles in /kb plus the
 * school's own SOPs), in the user's language, in numbered steps, limited to the features the
 * user's role and enabled modules allow. It explains and navigates; it never changes data.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { flagModuleFor, type Lang, type ModuleKey, type PermissionModule } from '@autoed/shared';
import { NotFoundError, ValidationError, insert, maybe, q, update, type Tx } from '../db';
import { rank, run, type Ctx } from '../core';
import { generate } from './ai';
import { chunkText, embed, toVectorLiteral } from '../adapters/channels';

interface KbFront {
  slug: string;
  title: string;
  screen?: string;
  module?: string;
  roles?: string[];
  tags?: string[];
}

function parseFrontmatter(text: string): { meta: KbFront; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('missing frontmatter');
  const meta: Record<string, unknown> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2]!.trim();
    meta[kv[1]!] = v.startsWith('[') ? v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean) : v.replace(/^"|"$/g, '');
  }
  return { meta: meta as unknown as KbFront, body: m[2]!.trim() };
}

/** Loads /kb/<lang>/*.md into kb_articles (global) and kb_chunks. Idempotent. */
export async function loadKb(c: Tx, dir: string): Promise<{ articles: number; chunks: number }> {
  let articles = 0;
  let chunks = 0;
  for (const lang of ['en', 'hi', 'te'] as const) {
    let files: string[] = [];
    try {
      files = (await readdir(join(dir, lang))).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      const { meta, body } = parseFrontmatter(await readFile(join(dir, lang, f), 'utf8'));
      const existing = await maybe<{ id: string }>(c, `select id from public.kb_articles where org_id is null and slug = $1 and language = $2`, [meta.slug, lang]);
      const row = { org_id: null, slug: meta.slug, language: lang, title: meta.title, body, screen_path: meta.screen ?? null, module_key: meta.module ?? null, role_keys: meta.roles ?? [], tags: meta.tags ?? [] };
      const art = existing ? await update<{ id: string }>(c, 'kb_articles', existing.id, row) : await insert<{ id: string }>(c, 'kb_articles', row);
      await c.query(`delete from public.kb_chunks where article_id = $1`, [art.id]);
      // One chunk per article keeps steps together; long articles split.
      const parts = body.length > 1500 ? chunkText(body, 1200) : [body];
      let seq = 1;
      for (const part of parts) {
        const content = `${meta.title}\n${part}`;
        await c.query(`insert into public.kb_chunks (org_id, article_id, language, seq, content, embedding) values (null,$1,$2,$3,$4,$5::vector)`, [art.id, lang, seq++, content, toVectorLiteral(embed(`${meta.title} ${meta.title} ${part}`))]);
        chunks++;
      }
      articles++;
    }
  }
  return { articles, chunks };
}

/** Embeds a school's SOP article (visible only to its staff). */
export async function addSop(ctx: Ctx, input: { title: string; body: string; language: Lang }) {
  return run(ctx, async (c) => {
    const slug = `sop-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}-${Date.now().toString(36)}`;
    const art = await insert<{ id: string }>(c, 'kb_articles', { org_id: ctx.orgId, slug, language: input.language, title: input.title, body: input.body, tags: ['sop'] });
    let seq = 1;
    for (const part of chunkText(input.body, 1200)) await c.query(`insert into public.kb_chunks (org_id, article_id, language, seq, content, embedding) values ($1,$2,$3,$4,$5,$6::vector)`, [ctx.orgId, art.id, input.language, seq++, `${input.title}\n${part}`, toVectorLiteral(embed(`${input.title} ${part}`))]);
    return { id: art.id };
  });
}

const MIN_SCORE = 0.18;

interface Hit {
  article_id: string;
  title: string;
  body: string;
  screen_path: string | null;
  module_key: string | null;
  role_keys: string[];
  score: number;
  text_rank: number;
}

async function retrieve(c: Tx, ctx: Ctx, question: string, lang: Lang): Promise<Hit[]> {
  const roleKeys = (await q<{ key: string }>(c, `select r.key from public.staff_roles sr join public.roles r on r.id = sr.role_id where sr.staff_id = $1`, [ctx.staffId])).map((r) => r.key);
  const hits = await q<Hit>(
    c,
    `select a.id as article_id, a.title, a.body, a.screen_path, a.module_key, a.role_keys,
            1 - (k.embedding <=> $2::vector) as score,
            ts_rank(k.tsv, plainto_tsquery('simple', $3)) as text_rank
     from public.kb_chunks k join public.kb_articles a on a.id = k.article_id
     where k.language = $1 and a.deleted_at is null and (a.org_id is null or a.org_id = $4)
     order by (1 - (k.embedding <=> $2::vector)) + least(ts_rank(k.tsv, plainto_tsquery('simple', $3)), 0.3) desc limit 12`,
    [lang, toVectorLiteral(embed(question)), question, ctx.orgId],
  );
  // Limit to features the user's role and the branch's enabled modules allow.
  return hits.filter((h) => {
    if (h.module_key) {
      const flag = flagModuleFor(h.module_key as PermissionModule);
      if (flag && ctx.modules[flag as ModuleKey] === false) return false;
      if (rank(ctx, h.module_key as PermissionModule, 'view') === 0) return false;
    }
    if (h.role_keys?.length && !h.role_keys.some((r) => roleKeys.includes(r))) return false;
    return true;
  });
}

const BOT_SCHEMA = { type: 'object', additionalProperties: false, required: ['answerable', 'steps', 'screen'], properties: { answerable: { type: 'boolean' }, steps: { type: 'array', items: { type: 'string' } }, screen: { type: ['string', 'null'] } } };
const botZod = z.object({ answerable: z.boolean(), steps: z.array(z.string()), screen: z.string().nullable() });

export interface BotMessage {
  role: 'user' | 'assistant';
  content: string;
  steps?: string[];
  link?: string | null;
  answerable?: boolean;
  at: string;
}

export async function askBot(ctx: Ctx, input: { conversation_id?: string | null; message: string; screen_path?: string }) {
  if (ctx.modules.help_bot === false) throw new ValidationError('module_disabled');
  return run(ctx, async (c, sys) => {
    let conv = input.conversation_id ? await maybe<{ id: string; messages: BotMessage[] }>(c, `select id, messages from public.bot_conversations where id = $1`, [input.conversation_id]) : null;
    if (input.conversation_id && !conv) throw new NotFoundError();
    if (!conv) conv = await insert<{ id: string; messages: BotMessage[] }>(c, 'bot_conversations', { org_id: ctx.orgId, branch_id: ctx.branchId, staff_id: ctx.staffId, language: ctx.lang, screen_path: input.screen_path ?? null, messages: [] });
    const hits = await retrieve(c, ctx, `${input.message}`, ctx.lang);
    const relevant = hits.filter((h) => h.score >= MIN_SCORE && h.text_rank > 0).slice(0, 3);
    let answer: { answerable: boolean; steps: string[]; screen: string | null } = { answerable: false, steps: [], screen: null };
    if (relevant.length) {
      const gen = await sys(() =>
        generate(c, {
          orgId: ctx.orgId,
          branchId: ctx.branchId,
          staffId: ctx.staffId,
          action: 'help_bot',
          tier: 'fast',
          system: `You are the AutoEd OS help assistant. Answer ONLY from the help articles provided, in ${ctx.lang === 'hi' ? 'Hindi' : ctx.lang === 'te' ? 'Telugu' : 'English'}, as short numbered steps. If the articles do not answer the question, set answerable to false. You explain and navigate; you never change data. Set "screen" to the article's screen path when one fits.`,
          prompt: `Question: ${input.message}\nCurrent screen: ${input.screen_path ?? 'unknown'}\n\nArticles:\n${relevant.map((h) => `### ${h.title} (screen: ${h.screen_path ?? 'none'})\n${h.body}`).join('\n\n')}`,
          jsonSchema: BOT_SCHEMA,
          zod: botZod,
          mockContext: { snippets: relevant.map((h) => ({ title: h.title, body: h.body, screen: h.screen_path })) },
          logInput: { question: input.message.slice(0, 300), lang: ctx.lang },
        }),
      );
      answer = gen.output as typeof answer;
    }
    const now = ctx.now.toISOString();
    const reply: BotMessage = answer.answerable && answer.steps.length ? { role: 'assistant', content: answer.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), steps: answer.steps, link: answer.screen, answerable: true, at: now } : { role: 'assistant', content: ctx.t('bot.cannotAnswer'), answerable: false, link: null, at: now };
    const messages = [...conv.messages, { role: 'user' as const, content: input.message, at: now }, reply];
    await update(c, 'bot_conversations', conv.id, { messages, status: reply.answerable ? 'answered' : 'unanswered', screen_path: input.screen_path ?? null });
    return { conversation_id: conv.id, message: reply, index: messages.length - 1 };
  });
}

export async function botFeedback(ctx: Ctx, input: { conversation_id: string; message_index: number; rating: 1 | -1; comment?: string }) {
  return run(ctx, async (c) => {
    const conv = await maybe<{ messages: BotMessage[] }>(c, `select messages from public.bot_conversations where id = $1`, [input.conversation_id]);
    if (!conv) throw new NotFoundError();
    const question = conv.messages[input.message_index - 1]?.content ?? null;
    return insert(c, 'bot_feedback', { org_id: ctx.orgId, branch_id: ctx.branchId, conversation_id: input.conversation_id, staff_id: ctx.staffId, message_index: input.message_index, rating: input.rating, question, comment: input.comment ?? null });
  });
}

/** If the bot cannot answer, it offers a support ticket to AutoEd with the conversation attached. */
export async function escalateToSupport(ctx: Ctx, conversationId: string) {
  return run(ctx, async (c) => {
    const conv = await maybe<{ messages: BotMessage[] }>(c, `select messages from public.bot_conversations where id = $1`, [conversationId]);
    if (!conv) throw new NotFoundError();
    const lastQ = [...conv.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const t = await insert<{ id: string }>(c, 'support_tickets', { org_id: ctx.orgId, branch_id: ctx.branchId, staff_id: ctx.staffId, subject: lastQ.slice(0, 200), body: conv.messages.map((m) => `${m.role}: ${m.content}`).join('\n'), conversation_id: conversationId });
    await update(c, 'bot_conversations', conversationId, { status: 'escalated' });
    return { id: t.id };
  });
}

export async function articleCoverage(c: Tx) {
  return q(c, `select slug, array_agg(language order by language) as languages, max(screen_path) as screen from public.kb_articles where org_id is null and deleted_at is null group by slug order by slug`);
}
