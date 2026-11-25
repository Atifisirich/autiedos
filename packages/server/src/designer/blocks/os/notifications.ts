/**
 * os.notification_rule -> core.notification_rules (product 'os', org level, one row per event and audience).
 * os.report_schedule   -> os.report_schedules of the active branch (one per report key); recipients are the holders
 *                         of the named roles, stored as staff ids like the report screen does.
 *
 * core.notification_rules is guarded by the core 'notifications' permission module, which the OS role matrix does not
 * have (the generic settings screen has the same gap, see docs/designer.md "Known gaps"). For school management the write
 * therefore runs as the org's OS system actor AFTER the designer's own management check; a relationship manager's
 * read-write support session passes RLS directly and is audited as such.
 */
import { insert, maybe, q, withSystem } from '../../../db';
import { clean, hm, osRoleId, type ApplyCtx, type ServerBlock, type Settings } from '../types';

async function checked<T>(x: ApplyCtx, fn: () => Promise<T>): Promise<T> {
  return x.actor.kind === 'org_admin' ? withSystem(x.c, x.actor.orgId, fn) : fn();
}

function split(key: string): { event: string; audience: string } {
  const i = key.lastIndexOf('__');
  return i > 0 ? { event: key.slice(0, i), audience: key.slice(i + 2) } : { event: key, audience: 'staff' };
}

const rule = (x: ApplyCtx, key: string) => {
  const { event, audience } = split(key);
  return maybe<{ id: string; event_key: string; audience: string; role_keys: string[]; channels: string[]; active: boolean; settings: Record<string, unknown> }>(
    x.c,
    `select id, event_key, audience, role_keys, channels, active, settings from core.notification_rules
      where org_id = $1 and product_key = 'os' and branch_id is null and event_key = $2 and audience = $3 and deleted_at is null order by created_at limit 1`,
    [x.actor.orgId, event, audience],
  );
};

export const notificationRuleServer: ServerBlock = {
  key: 'os.notification_rule',
  async read(x, key) {
    const r = await rule(x, key);
    if (!r) return null;
    return clean({ event_key: r.event_key, audience: r.audience, role_keys: r.role_keys ?? [], channels: r.channels ?? [], active: r.active, urgent: !!r.settings?.urgent, message: (r.settings?.message as string | undefined) ?? null });
  },
  list: (x) => q(x.c, `select event_key || '__' || audience as key, event_key as name from core.notification_rules where org_id = $1 and product_key = 'os' and branch_id is null and deleted_at is null order by event_key`, [x.actor.orgId]),
  async write(x, key, s) {
    for (const r of (s.role_keys as string[]) ?? []) await osRoleId(x, r);
    const ex = await rule(x, key);
    const settings: Record<string, unknown> = { ...(ex?.settings ?? {}), urgent: !!s.urgent };
    if (s.message) settings.message = s.message;
    else delete settings.message;
    await checked(x, async () => {
      if (ex) await x.c.query(`update core.notification_rules set role_keys = $2, channels = $3, active = $4, settings = $5 where id = $1`, [ex.id, s.role_keys ?? [], s.channels, s.active ?? true, JSON.stringify(settings)]);
      else await x.c.query(`insert into core.notification_rules (org_id, product_key, event_key, audience, role_keys, channels, active, settings) values ($1, 'os', $2, $3, $4, $5, $6, $7)`, [x.actor.orgId, s.event_key, s.audience ?? 'staff', s.role_keys ?? [], s.channels, s.active ?? true, JSON.stringify(settings)]);
    });
  },
  async remove(x, key) {
    const ex = await rule(x, key);
    if (ex) await checked(x, () => x.c.query(`update core.notification_rules set deleted_at = now() where id = $1`, [ex.id]));
  },
  // the settings jsonb may hold keys the block does not manage (optional, template ids): undo restores the row as it was
  async capture(x, key) {
    const r = await rule(x, key);
    return r ? { role_keys: r.role_keys ?? [], channels: r.channels ?? [], active: r.active, settings: r.settings ?? {} } : null;
  },
  async restore(x, key, state) {
    const ex = await rule(x, key);
    if (state === null) {
      if (ex) await checked(x, () => x.c.query(`update core.notification_rules set deleted_at = now() where id = $1`, [ex.id]));
      return;
    }
    const { event, audience } = split(key);
    const st = state as { role_keys: string[]; channels: string[]; active: boolean; settings: Record<string, unknown> };
    await checked(x, async () => {
      if (ex) await x.c.query(`update core.notification_rules set role_keys = $2, channels = $3, active = $4, settings = $5 where id = $1`, [ex.id, st.role_keys, st.channels, st.active, JSON.stringify(st.settings)]);
      else await x.c.query(`insert into core.notification_rules (org_id, product_key, event_key, audience, role_keys, channels, active, settings) values ($1, 'os', $2, $3, $4, $5, $6, $7)`, [x.actor.orgId, event, audience, st.role_keys, st.channels, st.active, JSON.stringify(st.settings)]);
    });
  },
};

// ---------------------------------------------------------------- report and digest schedules
const schedule = (x: ApplyCtx, key: string) =>
  maybe<{ id: string; report_key: string; frequency: string; send_time: string; weekday: number | null; recipient_ids: string[]; channel: string; active: boolean }>(
    x.c,
    `select id, report_key, frequency, send_time::text, weekday, recipient_ids, channel, active from os.report_schedules where org_id = $1 and branch_id = $2 and report_key = $3 and deleted_at is null order by created_at limit 1`,
    [x.actor.orgId, x.actor.branchId, key],
  );

async function holders(x: ApplyCtx, roleKeys: string[]): Promise<string[]> {
  return (
    await q<{ id: string }>(
      x.c,
      `select distinct s.id from core.staff s join os.staff_roles sr on sr.staff_id = s.id and sr.deleted_at is null join os.roles r on r.id = sr.role_id
        where s.org_id = $1 and r.key = any($2) and s.status = 'active' and s.deleted_at is null and (s.branch_id = $3 or s.branch_id is null) order by s.id`,
      [x.actor.orgId, roleKeys, x.actor.branchId],
    )
  ).map((r) => r.id);
}

async function rolesOf(x: ApplyCtx, staffIds: string[]): Promise<string[]> {
  if (!staffIds.length) return [];
  return (await q<{ key: string }>(x.c, `select distinct r.key from os.staff_roles sr join os.roles r on r.id = sr.role_id where sr.staff_id = any($1) and sr.deleted_at is null order by r.key`, [staffIds])).map((r) => r.key);
}

async function writeSchedule(x: ApplyCtx, key: string, raw: { frequency: unknown; send_time: unknown; weekday: unknown; recipient_ids: string[]; channel: unknown; active: boolean }) {
  const ex = await schedule(x, key);
  if (ex) await x.c.query(`update os.report_schedules set frequency = $2, send_time = $3, weekday = $4, recipient_ids = $5, channel = $6, active = $7 where id = $1`, [ex.id, raw.frequency, raw.send_time, raw.weekday ?? null, raw.recipient_ids, raw.channel, raw.active]);
  else await insert(x.c, 'os.report_schedules', { org_id: x.actor.orgId, branch_id: x.actor.branchId, report_key: key, saved_report_id: null, frequency: raw.frequency, send_time: raw.send_time, weekday: raw.weekday ?? null, recipient_ids: raw.recipient_ids, channel: raw.channel, active: raw.active });
}

export const reportScheduleServer: ServerBlock = {
  key: 'os.report_schedule',
  async read(x, key) {
    const r = await schedule(x, key);
    if (!r || !r.active) return null;
    return clean({ report_key: r.report_key, frequency: r.frequency, send_time: hm(r.send_time), weekday: r.weekday, recipient_role_keys: await rolesOf(x, r.recipient_ids ?? []), channel: r.channel });
  },
  list: (x) => q(x.c, `select report_key as key, report_key as name from os.report_schedules where org_id = $1 and branch_id = $2 and active and deleted_at is null and report_key not like 'saved:%'`, [x.actor.orgId, x.actor.branchId]),
  async write(x, key, s) {
    for (const r of s.recipient_role_keys as string[]) await osRoleId(x, r);
    await writeSchedule(x, key, { frequency: s.frequency, send_time: s.send_time, weekday: s.weekday, recipient_ids: await holders(x, s.recipient_role_keys as string[]), channel: s.channel, active: true });
  },
  async remove(x, key) {
    const r = await schedule(x, key);
    if (r) await x.c.query(`update os.report_schedules set deleted_at = now() where id = $1`, [r.id]);
  },
  // recipients are staff ids: undo puts back exactly the people who were there
  async capture(x, key) {
    const r = await schedule(x, key);
    return r ? ({ frequency: r.frequency, send_time: hm(r.send_time), weekday: r.weekday, recipient_ids: r.recipient_ids ?? [], channel: r.channel, active: r.active } as Settings) : null;
  },
  async restore(x, key, state) {
    if (state === null) {
      const r = await schedule(x, key);
      if (r) await x.c.query(`update os.report_schedules set deleted_at = now() where id = $1`, [r.id]);
      return;
    }
    await writeSchedule(x, key, state as { frequency: unknown; send_time: unknown; weekday: unknown; recipient_ids: string[]; channel: unknown; active: boolean });
  },
};
