// Meta integration: WhatsApp Business Cloud API and Facebook / Instagram lead ads.
// Ported from autoedcrm lib/meta.ts. Each school connects its own Meta Business account; credentials live in
// crm.org_secrets (AES-256-GCM with APP_SECRET). Templates are core.message_templates rows (product crm):
// meta_name / meta_status / meta_vars / meta_reason became provider_template_name / provider_status / provider_vars /
// provider_reason, and the language is a code (en, hi, te).
import crypto from 'node:crypto';
import { type Db, type Row } from './db';
import { captureEnquiry, findHousehold, logActivity, normMobile, receiveMessage, tenantSettings, templateStatus } from './core';
import { getSecret } from './secrets';

export const GRAPH = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION ?? 'v23.0'}`;

export type WaConfig = { phoneNumberId: string; wabaId: string; token: string; appSecret: string | null };

export async function waConfig(db: Db): Promise<WaConfig | null> {
  const s = (await tenantSettings(db)).integrations?.whatsapp;
  if (!s?.phone_number_id || !s?.enabled) return null;
  const token = await getSecret(db, 'wa_token');
  if (!token) return null;
  return { phoneNumberId: s.phone_number_id, wabaId: s.waba_id ?? '', token, appSecret: await getSecret(db, 'meta_app_secret') };
}

/** Indian numbers in E.164 without the plus, as the Cloud API expects. */
export const waNumber = (mobile: string) => {
  const m = normMobile(mobile);
  return m.length === 10 ? '91' + m : m;
};

async function graph(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const r = await fetch(`${GRAPH()}/${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, data: { error: { message: 'Could not reach Meta: ' + (e?.message ?? 'network error') } } };
  }
}

/**
 * Plain-language reasons for Cloud API error codes (L360-03). Counsellors never see raw codes;
 * admins get the code in brackets so they can look it up.
 */
export function waErrorText(code: number | undefined, title?: string): string {
  const map: Record<number, string> = {
    131026: 'This number cannot receive WhatsApp messages. Try SMS or call.',
    131047: 'More than 24 hours since the parent last wrote, so only an approved template can be sent.',
    131049: "WhatsApp held back this marketing message to protect the parent's inbox. Try again later or call.",
    131050: 'The parent has stopped marketing messages from the school.',
    131051: 'This kind of message is not supported.',
    131052: 'The media in this message could not be downloaded.',
    131053: 'The attached file could not be uploaded.',
    131056: 'Too many messages to this parent in a short time. Wait a few minutes.',
    131008: 'A required part of the message is missing.',
    131009: 'One of the values in the message is not valid.',
    131021: "The school cannot message its own WhatsApp number.",
    131031: "The school's WhatsApp account is locked. Check WhatsApp Manager.",
    131042: "There is a payment problem on the school's WhatsApp account. Check the payment method in Meta Business Suite.",
    131045: "The school's WhatsApp number is not fully registered yet.",
    132000: "The template's placeholders did not match. Ask your admin to resync templates.",
    132001: 'That template is not approved on WhatsApp yet.',
    132005: 'The message text is too long for this template.',
    132007: 'WhatsApp rejected the template content.',
    132012: "The template's placeholders did not match. Ask your admin to resync templates.",
    132015: 'This template was paused by WhatsApp because of low quality.',
    132016: 'This template was disabled by WhatsApp.',
    130429: "WhatsApp is limiting how fast the school can send. Messages will need to be retried.",
    131000: 'WhatsApp had a temporary problem. Try again.',
    190: 'The WhatsApp connection has expired. Ask your admin to reconnect it.',
    10: 'The WhatsApp connection is missing a permission. Ask your admin to reconnect it.',
    200: 'The WhatsApp connection is missing a permission. Ask your admin to reconnect it.',
    100: 'WhatsApp did not accept the request. Ask your admin to check the connection settings.',
    368: "The school's WhatsApp account is temporarily blocked for policy reasons. Check WhatsApp Manager.",
    470: 'More than 24 hours since the parent last wrote, so only an approved template can be sent.',
    1: 'WhatsApp had a temporary problem. Try again.',
    2: 'WhatsApp had a temporary problem. Try again.',
  };
  return (code && map[code]) || `WhatsApp could not deliver this message${title ? ` (${title})` : ''}. Try SMS or call.`;
}

/** Converts {{named}} variables to Meta's positional {{1}}, {{2}} and remembers the order. */
export function toMetaBody(body: string): { text: string; vars: string[] } {
  const vars: string[] = [];
  const text = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    let i = vars.indexOf(k);
    if (i < 0) {
      vars.push(k);
      i = vars.length - 1;
    }
    return `{{${i + 1}}}`;
  });
  return { text, vars };
}

const LANGS: Record<string, string> = { English: 'en', Hindi: 'hi', Telugu: 'te', Kannada: 'kn', Tamil: 'ta', Marathi: 'mr', Malayalam: 'ml', Bengali: 'bn', Gujarati: 'gu', Urdu: 'ur' };
/** Accepts a language code (core.message_templates) or one of the CRM's old language names. */
export const langCode = (language: string) => LANGS[language] ?? (/^[a-z]{2}$/.test(language) ? language : 'en');

export const metaTemplateName = (name: string, language: string) =>
  (name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'template') + (language && langCode(language) !== 'en' ? '_' + langCode(language) : '');

const SAMPLE: Record<string, string> = { guardian_name: 'Priya', student_name: 'Aarav', grade: 'Grade 1', branch: 'Main campus', counsellor: 'Meera', school: 'Greenfield School', apply_link: 'https://example.com/apply/abc', year: '2027-28' };

export type SendResult = { ok: true; id: string } | { ok: false; reason: string; code?: number };

export async function waSendText(cfg: WaConfig, to: string, body: string): Promise<SendResult> {
  const r = await graph(`${cfg.phoneNumberId}/messages`, cfg.token, { method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: waNumber(to), type: 'text', text: { preview_url: true, body } } });
  return r.ok ? { ok: true, id: r.data.messages?.[0]?.id ?? '' } : { ok: false, reason: waErrorText(r.data?.error?.code, r.data?.error?.message), code: r.data?.error?.code };
}

export async function waSendTemplate(cfg: WaConfig, to: string, tpl: Row, vars: Record<string, string | null | undefined>): Promise<SendResult> {
  const params = ((tpl.provider_vars as string[]) ?? []).map((k) => ({ type: 'text', text: String(vars[k] ?? '-').slice(0, 1000) || '-' }));
  const r = await graph(`${cfg.phoneNumberId}/messages`, cfg.token, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to: waNumber(to), type: 'template', template: { name: tpl.provider_template_name, language: { code: langCode(tpl.language) }, components: params.length ? [{ type: 'body', parameters: params }] : [] } },
  });
  return r.ok ? { ok: true, id: r.data.messages?.[0]?.id ?? '' } : { ok: false, reason: waErrorText(r.data?.error?.code, r.data?.error?.message), code: r.data?.error?.code };
}

/** Checks the number and token; used by the admin "Test connection" button. */
export async function waTest(cfg: WaConfig): Promise<{ ok: boolean; text: string }> {
  const r = await graph(`${cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`, cfg.token);
  if (!r.ok) return { ok: false, text: 'Meta said: ' + (r.data?.error?.message ?? `HTTP ${r.status}`) };
  return { ok: true, text: `Connected to ${r.data.verified_name ?? 'your number'} (${r.data.display_phone_number ?? 'number hidden'}), quality ${r.data.quality_rating ?? 'unknown'}.` };
}

/** Submits every local WhatsApp template that Meta does not have yet, then refreshes statuses. */
export async function syncTemplates(db: Db): Promise<{ submitted: number; updated: number; errors: string[] }> {
  const org = db.requireOrg();
  const cfg = await waConfig(db);
  if (!cfg?.wabaId) return { submitted: 0, updated: 0, errors: ['Add the WhatsApp Business Account ID first.'] };
  const local = await db.q("select * from core.message_templates where org_id = $1 and product_key = 'crm' and channel = 'whatsapp' and deleted_at is null", [org]);
  const remote = await graph(`${cfg.wabaId}/message_templates?fields=name,language,status,rejected_reason&limit=200`, cfg.token);
  if (!remote.ok) return { submitted: 0, updated: 0, errors: ['Meta said: ' + (remote.data?.error?.message ?? `HTTP ${remote.status}`)] };
  const byName = new Map<string, Row>((remote.data.data ?? []).map((t: Row) => [`${t.name}|${t.language}`, t]));
  let submitted = 0,
    updated = 0;
  const errors: string[] = [];
  for (const t of local) {
    const name = t.provider_template_name ?? metaTemplateName(t.name, t.language);
    const { text, vars } = toMetaBody(t.body);
    const found = byName.get(`${name}|${langCode(t.language)}`);
    if (found) {
      await db.q('update core.message_templates set provider_template_name = $2, provider_vars = $3, provider_status = $4, provider_reason = $5, status = $6 where id = $1', [
        t.id, name, t.provider_vars?.length ? t.provider_vars : vars, found.status, found.rejected_reason && found.rejected_reason !== 'NONE' ? found.rejected_reason : null, templateStatus(found.status),
      ]);
      updated++;
      continue;
    }
    const r = await graph(`${cfg.wabaId}/message_templates`, cfg.token, {
      method: 'POST',
      body: {
        name, language: langCode(t.language), category: t.category === 'marketing' ? 'MARKETING' : 'UTILITY',
        components: [{ type: 'BODY', text, ...(vars.length ? { example: { body_text: [vars.map((v) => SAMPLE[v] ?? 'Sample')] } } : {}) }],
      },
    });
    if (r.ok) {
      await db.q("update core.message_templates set provider_template_name = $2, provider_vars = $3, provider_status = $4, status = 'submitted', provider_reason = null where id = $1", [t.id, name, vars, r.data.status ?? 'PENDING']);
      submitted++;
    } else errors.push(`${t.name}: ${r.data?.error?.error_user_msg ?? r.data?.error?.message ?? 'rejected'}`);
  }
  return { submitted, updated, errors };
}

// ---------- webhooks ----------

export function verifySignature(raw: string, header: string | null, appSecret: string | null): boolean {
  if (!appSecret) return false;
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function inboundText(m: Row): string {
  switch (m.type) {
    case 'text': return m.text?.body ?? '';
    case 'button': return m.button?.text ?? '';
    case 'interactive': return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '[Reply]';
    case 'image': return '[Photo received]' + (m.image?.caption ? ` ${m.image.caption}` : '');
    case 'document': return '[Document received]' + (m.document?.filename ? ` ${m.document.filename}` : '');
    case 'audio': return '[Voice note received]';
    case 'video': return '[Video received]';
    case 'location': return '[Location shared]';
    case 'contacts': return '[Contact card shared]';
    case 'reaction': return `[Reacted ${m.reaction?.emoji ?? ''}]`;
    default: return `[${m.type ?? 'Unsupported'} message]`;
  }
}

/** Handles one webhook delivery for an org (the db is bound to it). Returns a short log line per event. */
export async function handleMetaWebhook(db: Db, payload: Row): Promise<string[]> {
  const org = db.requireOrg();
  const log: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (change.field === 'messages') {
        const names = new Map<string, string>((v.contacts ?? []).map((c: Row) => [c.wa_id, c.profile?.name ?? '']));
        for (const m of v.messages ?? []) {
          if (m.type === 'reaction') continue;
          const from = String(m.from ?? '');
          if (await db.one('select 1 from crm.messages where org_id = $1 and provider_id = $2', [org, m.id])) {
            log.push(`duplicate ${m.id}`);
            continue;
          }
          let hh = (await findHousehold(db, { mobile: from }))?.household_id as string | undefined;
          if (!hh) {
            const branch = await db.one('select id from core.branches where org_id = $1 and active order by name limit 1', [org]);
            const res = await captureEnquiry(db, { studentName: 'Name not given yet', guardianName: names.get(from) || 'Parent', mobile: from, branchId: branch!.id, channel: 'WhatsApp', source: 'School WhatsApp number', consent: { source: 'Parent messaged the school on WhatsApp first' } });
            if (!res.ok) {
              log.push(`could not create household: ${res.error}`);
              continue;
            }
            hh = res.householdId;
            log.push(`new household ${hh}`);
          }
          await receiveMessage(db, hh, 'whatsapp', inboundText(m));
          await db.q("update crm.messages set provider_id = $3 where id = (select id from crm.messages where org_id = $1 and household_id = $2 and direction = 'in' order by created_at desc limit 1)", [org, hh, m.id]);
          log.push(`inbound from ${from}`);
        }
        for (const st of v.statuses ?? []) {
          const msg = await db.one('select * from crm.messages where org_id = $1 and provider_id = $2', [org, st.id]);
          if (!msg) {
            log.push(`status for unknown ${st.id}`);
            continue;
          }
          if (st.status === 'delivered') await db.q("update crm.messages set status = case when status = 'read' then status else 'delivered' end, delivered_at = coalesce(delivered_at, now()) where id = $1", [msg.id]);
          else if (st.status === 'read') await db.q("update crm.messages set status = 'read', read_at = coalesce(read_at, now()), delivered_at = coalesce(delivered_at, now()) where id = $1", [msg.id]);
          else if (st.status === 'failed') {
            const err = st.errors?.[0];
            const reason = waErrorText(err?.code, err?.title);
            await db.q("update crm.messages set status = 'failed', fail_reason = $2 where id = $1", [msg.id, reason]);
            await logActivity(db, { householdId: msg.household_id, enquiryId: msg.enquiry_id, type: 'whatsapp', content: `Not delivered: ${reason}`, meta: { direction: 'out', status: 'failed', body: msg.body } });
          }
          log.push(`status ${st.status} for ${st.id}`);
        }
      } else if (change.field === 'message_template_status_update') {
        const status = String(v.event ?? '').toUpperCase();
        await db.q(
          "update core.message_templates set provider_status = $3, provider_reason = $4, status = case when $3 = 'APPROVED' then 'approved' when $3 in ('REJECTED','DISABLED') then 'rejected' when $3 = 'PAUSED' then 'paused' else status end where org_id = $1 and product_key = 'crm' and provider_template_name = $2",
          [org, v.message_template_name, status, v.reason && v.reason !== 'NONE' ? v.reason : null],
        );
        log.push(`template ${v.message_template_name} ${status}`);
      } else if (change.field === 'leadgen') {
        log.push(await handleLead(db, v));
      }
    }
  }
  return log;
}

// ---------- lead ads ----------

type LeadField = { name: string; values: string[] };

/** Maps a lead form's answers onto an enquiry. Question names are matched loosely so most school forms work unchanged. */
export function mapLeadFields(fields: LeadField[], grades: string[], branches: Row[]) {
  const out: { studentName?: string; guardianName?: string; mobile?: string; email?: string; grade?: string; branchId?: string; locality?: string; extra: string[] } = { extra: [] };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const f of fields) {
    const n = norm(f.name);
    const v = (f.values ?? []).join(', ').trim();
    if (!v) continue;
    if (/(child|student|kid|ward)/.test(n) && /name/.test(n)) out.studentName = v;
    else if (/(phone|mobile|whatsapp|contact number)/.test(n)) out.mobile = v;
    else if (/email/.test(n)) out.email = v;
    else if (/(grade|class|standard|admission for)/.test(n)) out.grade = grades.find((g) => norm(g) === norm(v) || norm(v).includes(norm(g))) ?? (out.extra.push(`${f.name}: ${v}`), undefined);
    else if (/(campus|branch|school location|centre|center)/.test(n)) out.branchId = branches.find((b) => norm(v).includes(norm(b.name).replace(/ campus$/, '')) || norm(b.name).includes(norm(v)))?.id ?? (out.extra.push(`${f.name}: ${v}`), undefined);
    else if (/(city|locality|area|address|location)/.test(n)) out.locality = v;
    else if (n === 'full name' || n === 'name' || /(parent|father|mother|guardian)/.test(n)) out.guardianName = out.guardianName ?? v;
    else out.extra.push(`${f.name}: ${v}`);
  }
  return out;
}

async function handleLead(db: Db, v: Row): Promise<string> {
  const org = db.requireOrg();
  const leadId = String(v.leadgen_id ?? '');
  if (!leadId) return 'lead without id';
  if (await db.one('select 1 from crm.meta_leads where leadgen_id = $1', [leadId])) return `duplicate lead ${leadId}`;
  const token = await getSecret(db, 'meta_page_token');
  if (!token) {
    await db.insert('crm.meta_leads', { leadgen_id: leadId, org_id: org, status: 'failed', detail: 'No page access token saved' });
    return 'lead received but no page token';
  }
  const r = await graph(`${leadId}?fields=field_data,created_time,ad_name,campaign_name,form_id,platform`, token);
  if (!r.ok) {
    await db.insert('crm.meta_leads', { leadgen_id: leadId, org_id: org, status: 'failed', detail: r.data?.error?.message ?? `HTTP ${r.status}` });
    return `could not fetch lead ${leadId}`;
  }
  return importLead(db, leadId, r.data);
}

/** Turns a fetched Meta lead into an enquiry. Exported so tests and manual re-imports can call it directly. */
export async function importLead(db: Db, leadId: string, lead: Row): Promise<string> {
  const org = db.requireOrg();
  const s = await tenantSettings(db);
  const branches = await db.q('select id, name from core.branches where org_id = $1 and active order by name', [org]);
  const m = mapLeadFields(lead.field_data ?? [], s.grades ?? [], branches);
  const ig = lead.platform === 'ig' || lead.platform === 'instagram';
  const src = await db.one('select id from crm.sources where org_id = $1 and name = $2', [org, ig ? 'Instagram lead form' : 'Facebook lead form']);
  const res = await captureEnquiry(db, {
    studentName: m.studentName || 'Name not given yet', guardianName: m.guardianName || 'Parent', mobile: m.mobile ?? '', email: m.email, grade: m.grade, locality: m.locality,
    branchId: (m.branchId ?? branches[0]?.id)!, sourceId: src?.id, channel: 'Meta ads', source: ig ? 'Instagram lead form' : 'Facebook lead form',
    campaign: lead.campaign_name ?? lead.ad_name ?? undefined, utm: { form_id: lead.form_id, ad_name: lead.ad_name, campaign_name: lead.campaign_name, leadgen_id: leadId },
    consent: { source: `Meta lead form ${lead.form_id ?? ''}`.trim() }, note: m.extra.length ? m.extra.join('; ') : undefined,
  });
  await db.insert('crm.meta_leads', { leadgen_id: leadId, org_id: org, enquiry_id: res.ok ? res.enquiryId : null, status: res.ok ? res.status : 'failed', detail: res.ok ? null : res.error });
  return res.ok ? `lead ${leadId} -> ${res.status}` : `lead ${leadId} failed: ${res.error}`;
}

export async function pageTest(db: Db): Promise<{ ok: boolean; text: string }> {
  const s = (await tenantSettings(db)).integrations?.meta_leads;
  const token = await getSecret(db, 'meta_page_token');
  if (!s?.page_id || !token) return { ok: false, text: 'Save the Facebook Page ID and page access token first.' };
  const r = await graph(`${s.page_id}?fields=name`, token);
  if (!r.ok) return { ok: false, text: 'Meta said: ' + (r.data?.error?.message ?? `HTTP ${r.status}`) };
  const sub = await graph(`${s.page_id}/subscribed_apps`, token, { method: 'POST', body: { subscribed_fields: ['leadgen'] } });
  return sub.ok ? { ok: true, text: `Connected to the Page "${r.data.name}". New leads from its forms will arrive automatically.` } : { ok: false, text: `Found the Page "${r.data.name}" but could not subscribe to its leads: ${sub.data?.error?.message ?? 'unknown error'}` };
}
