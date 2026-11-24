import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { erp } from '@/lib/erp/db';
import { Page, Card, Empty, Badge } from '@/components/erp/ui';
import { ftime, today } from '@/lib/erp/fmt';
import { AutoRefresh } from '../driver/refresh';

export const metadata = { title: 'Live trips' };
type T = { id: string; direction: string; status: string; started_at: string; ended_at: string | null; delay_minutes: number; last_lat: number | null; last_lng: number | null; last_speed: number | null; last_at: string | null; route_id: string };
/** Transport manager console (TR-06): all buses, last position and exceptions. Refreshes every 20 seconds. */
export default async function Live() {
  const ctx = await requireCap('transport');
  const d = today();
  const [{ data: trips }, { data: ev }, { data: routes }, { data: veh }] = await Promise.all([
    erp(ctx.sb).from('trips').select('id, direction, status, started_at, ended_at, delay_minutes, last_lat, last_lng, last_speed, last_at, route_id').eq('date', d).is('deleted_at', null).order('started_at', { ascending: false }),
    erp(ctx.sb).from('trip_events').select('trip_id, type, note, at').gte('at', d + 'T00:00:00+05:30').order('at', { ascending: false }).limit(2000),
    erp(ctx.sb).from('routes').select('id, name, vehicle_id').is('deleted_at', null),
    erp(ctx.sb).from('vehicles').select('id, reg_no').is('deleted_at', null),
  ]);
  const Ts = (trips ?? []) as T[];
  const E = (ev ?? []) as { trip_id: string; type: string; note: string | null; at: string }[];
  const route = new Map(((routes ?? []) as { id: string; name: string; vehicle_id: string | null }[]).map((r) => [r.id, r]));
  const reg = new Map(((veh ?? []) as { id: string; reg_no: string }[]).map((v) => [v.id, v.reg_no]));
  const count = (id: string, type: string) => E.filter((e) => e.trip_id === id && e.type === type).length;
  const exceptions = E.filter((e) => ['sos', 'delay', 'overspeed', 'offroute'].includes(e.type));
  return (
    <Page title="Live trips" sub="Phone GPS from the driver app. Location is shared only while a trip is running." actions={<Link className="btn-ghost" href="/erp/transport">Transport</Link>}>
      <AutoRefresh seconds={20} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">{Ts.length === 0 ? <Card><Empty title="No trips today" hint="Drivers start a trip from the driver app; it appears here at once." /></Card> : Ts.map((t) => { const stale = t.status === 'running' && (!t.last_at || Date.now() - new Date(t.last_at).getTime() > 5 * 60000); const r = route.get(t.route_id); return (
          <Card key={t.id}><div className="flex flex-wrap items-center justify-between gap-3 p-4"><div><div className="font-semibold">{r?.name} <span className="font-normal text-muted">· {r?.vehicle_id ? reg.get(r.vehicle_id) : ''} · {t.direction}</span></div><div className="text-sm text-muted">Started {ftime(t.started_at)}{t.ended_at ? ` · ended ${ftime(t.ended_at)}` : ''} · {count(t.id, 'boarded')} boarded · {count(t.id, 'dropped')} dropped</div>
            {t.last_lat && <div className="text-sm">Last seen {ftime(t.last_at)}{t.last_speed ? ` · ${Math.round(Number(t.last_speed))} km/h` : ''} · <a className="link" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${t.last_lat}&mlon=${t.last_lng}#map=16/${t.last_lat}/${t.last_lng}`}>Open on map</a></div>}</div>
            <div className="flex flex-col items-end gap-1"><Badge>{t.status}</Badge>{t.delay_minutes > 0 && <Badge tone="amber">{t.delay_minutes} min late</Badge>}{stale && <Badge tone="red">no signal for 5+ min</Badge>}</div></div></Card>); })}</div>
        <Card title="Exceptions today">{exceptions.length === 0 ? <Empty title="No exceptions" hint="SOS, delays and over-speed alerts appear here and notify you." /> : <ul className="divide-y divide-line text-sm">{exceptions.map((e, i) => <li key={i} className="flex justify-between gap-2 px-4 py-2"><span><Badge tone={e.type === 'sos' ? 'red' : 'amber'}>{e.type}</Badge> {e.note}</span><span className="text-xs text-muted">{ftime(e.at)}</span></li>)}</ul>}</Card>
      </div>
    </Page>
  );
}
