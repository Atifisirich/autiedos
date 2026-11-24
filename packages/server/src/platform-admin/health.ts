/**
 * Client health: a plain, explainable summary for the clients list. Pure; thresholds are product defaults,
 * not owner decisions (the reasons are shown next to the badge so nobody has to guess).
 */
import { addDays } from '@autoed/shared';

export type HealthLevel = 'ok' | 'attention' | 'critical';

export type HealthReason =
  | 'client_suspended'
  | 'no_active_product'
  | 'access_expired'
  | 'no_subscription'
  | 'past_due'
  | 'product_off'
  | 'trial_ending'
  | 'locked_users'
  | 'no_active_user'
  | 'inactive';

export interface HealthInput {
  orgStatus: 'active' | 'closed';
  orgCreatedOn: string;
  today: string;
  subs: { status: string; ends_on: string | null; starts_on: string }[];
  stats: { user_count: number; active_user_count: number; invited_count: number; locked_count: number; last_login_date: string | null };
}

const CRITICAL: HealthReason[] = ['client_suspended', 'no_active_product', 'access_expired'];

export function computeHealth(i: HealthInput): { level: HealthLevel; reasons: HealthReason[] } {
  const r = new Set<HealthReason>();
  if (i.orgStatus === 'closed') r.add('client_suspended');
  if (!i.subs.length) r.add('no_subscription');
  const live = i.subs.filter((s) => ['trial', 'active', 'past_due'].includes(s.status));
  if (i.subs.length && !live.length) r.add('no_active_product');
  else if (i.subs.length && live.length < i.subs.length) r.add('product_off');
  if (i.subs.some((s) => s.status === 'past_due')) r.add('past_due');
  for (const s of live) {
    if (s.ends_on && s.ends_on < i.today) r.add('access_expired');
    if (s.status === 'trial' && s.ends_on && s.ends_on >= i.today && s.ends_on <= addDays(i.today, 7)) r.add('trial_ending');
  }
  if (i.stats.locked_count > 0) r.add('locked_users');
  if (i.stats.user_count > 0 && i.stats.active_user_count === 0 && i.stats.invited_count > 0) r.add('no_active_user');
  if (i.stats.active_user_count > 0) {
    const since = i.stats.last_login_date ?? i.orgCreatedOn;
    const grace = i.stats.last_login_date ? 30 : 14;
    if (addDays(since, grace) < i.today) r.add('inactive');
  }
  const reasons = [...r];
  const level: HealthLevel = reasons.some((x) => CRITICAL.includes(x)) ? 'critical' : reasons.length ? 'attention' : 'ok';
  return { level, reasons };
}
