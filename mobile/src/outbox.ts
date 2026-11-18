/**
 * Offline outbox (PRD 9.2): task actions, attendance, class logs and checklist answers are queued with a
 * client id and replayed through POST /sync when the network returns. The server de-duplicates on client id.
 */
import NetInfo from '@react-native-community/netinfo';
import { readJson, writeJson } from './storage';
import { ApiError, post } from './api';

export interface OutboxItem {
  client_id: string;
  method: 'POST' | 'PATCH';
  path: string; // /api/os/...
  body: unknown;
  created_at: string;
}
const KEY = 'outbox';
let flushing = false;
const listeners = new Set<(n: number) => void>();

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export async function pending(): Promise<OutboxItem[]> {
  return readJson<OutboxItem[]>(KEY, []);
}
export const onOutboxChange = (f: (n: number) => void) => (listeners.add(f), () => void listeners.delete(f));
async function save(items: OutboxItem[]) {
  await writeJson(KEY, items);
  listeners.forEach((f) => f(items.length));
}

/** Sends now if online; otherwise (or on a network error) queues. Returns 'sent' or 'queued'. */
export async function send(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>): Promise<'sent' | 'queued'> {
  const client_id = (body.client_id as string | undefined) ?? newId();
  const withId = { ...body, client_id };
  const net = await NetInfo.fetch();
  if (net.isConnected) {
    try {
      await post(path, withId);
      return 'sent';
    } catch (e) {
      if (e instanceof ApiError) throw e; // a real answer from the server (validation, permission): show it
    }
  }
  await save([...(await pending()), { client_id, method, path: `/api/os${path}`, body: withId, created_at: new Date().toISOString() }]);
  return 'queued';
}

/** Replays queued items in order. Items the server rejects are dropped with the reason kept in 'outbox_failed'. */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    let items = await pending();
    while (items.length) {
      const batch = items.slice(0, 50);
      const res = await post<{ results: { client_id: string; status: number; result?: unknown }[] }>('/sync', { items: batch });
      const failed = res.results.filter((r) => r.status >= 400 && r.status < 500);
      if (failed.length) await writeJson('outbox_failed', [...(await readJson<unknown[]>('outbox_failed', [])), ...failed].slice(-50));
      items = items.slice(batch.length);
      await save(items);
    }
  } catch {
    /* still offline or server error: keep the queue */
  } finally {
    flushing = false;
  }
}

export function startOutboxWatcher() {
  return NetInfo.addEventListener((s) => s.isConnected && void flush());
}
