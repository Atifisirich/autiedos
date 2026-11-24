import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { fullNameOf } from '@/lib/erp/q';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Stat } from '@/components/erp/ui';
import { fdate, today } from '@/lib/erp/fmt';
import { addDays } from '@/lib/erp/calendar';
import { entitiesOf } from '@/lib/erp/nav';

export const metadata = { title: 'Transport' };
type Veh = { id: string; reg_no: string; capacity: number; registration_expiry: string | null; fitness_expiry: string | null; insurance_expiry: string | null; permit_expiry: string | null; puc_expiry: string | null };
/** Transport console (TR-01, TR-02): routes with capacity checks and compliance documents with expiry alerts. */
export default async function Transport() {
  const ctx = await requireCap('transport');
  const [{ data: routes }, { data: vehicles }, { data: st }, { data: drivers }, { data: trips }, { data: prof }] = await Promise.all([
    erp(ctx.sb).from('routes').select('id, name, zone, monthly_fee, active, vehicle_id, driver_id, stops(count)').is('deleted_at', null).order('name'),
    erp(ctx.sb).from('vehicles').select('*').eq('active', true).is('deleted_at', null),
    erp(ctx.sb).from('student_transport').select('route_id').eq('active', true).is('deleted_at', null).limit(20000),
    core(ctx.sb).from('staff').select('id, first_name, last_name').in('staff_type', ['driver', 'attendant']).eq('status', 'active').is('deleted_at', null),
    erp(ctx.sb).from('trips').select('id, status').eq('date', today()).is('deleted_at', null),
    erp(ctx.sb).from('staff_hr_profiles').select('staff_id, licence_expiry, bgv_status').is('deleted_at', null),
  ]);
  const d = today(), soon = addDays(d, 30);
  const V = (vehicles ?? []) as Veh[];
  const riders = new Map<string, number>(); for (const s of (st ?? []) as { route_id: string }[]) riders.set(s.route_id, (riders.get(s.route_id) ?? 0) + 1);
  const hp = new Map(((prof ?? []) as { staff_id: string; licence_expiry: string | null; bgv_status: string }[]).map((p) => [p.staff_id, p]));
  const alerts: { what: string; when: string; expired: boolean }[] = [];
  for (const v of V) for (const [k, l] of [['registration_expiry', 'Registration'], ['fitness_expiry', 'Fitness certificate'], ['insurance_expiry', 'Insurance'], ['permit_expiry', 'Permit'], ['puc_expiry', 'Pollution certificate']] as const) { const x = v[k]; if (x && x <= soon) alerts.push({ what: `${v.reg_no} · ${l}`, when: x, expired: x < d }); }
  for (const s of (drivers ?? []) as { id: string; first_name: string; last_name: string | null }[]) { const p = hp.get(s.id); if (p?.licence_expiry && p.licence_expiry <= soon) alerts.push({ what: `${fullNameOf(s)} · Driving licence`, when: p.licence_expiry, expired: p.licence_expiry < d }); if (p && p.bgv_status !== 'clear') alerts.push({ what: `${fullNameOf(s)} · Background verification ${p.bgv_status}`, when: d, expired: p.bgv_status === 'flagged' }); }
  const R = (routes ?? []) as unknown as { id: string; name: string; zone: string | null; monthly_fee: number | null; active: boolean; vehicle_id: string | null; driver_id: string | null; stops: { count: number }[] }[];
  const dr = await lookup(ctx, 'staff', R.map((r) => r.driver_id));
  const veh = new Map(V.map((v) => [v.id, v]));
  const T = (trips ?? []) as { id: string; status: string }[];
  const can = ctx.can('transport', 'write');
  return (
    <Page title="Transport" sub="Routes, vehicles, compliance and live trips." actions={<><Link className="btn-ghost" href="/erp/transport/live">Live trips</Link><Link className="btn-ghost" href="/erp/transport/driver">Driver app</Link>{can && <Link className="btn" href="/erp/x/routes/new?back=/erp/transport">New route</Link>}</>}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Routes" value={R.filter((r) => r.active).length} /><Stat label="Students on transport" value={(st ?? []).length} /><Stat label="Trips today" value={T.length} hint={`${T.filter((t) => t.status === 'running').length} running`} href="/erp/transport/live" /><Stat label="Compliance alerts" value={alerts.length} tone={alerts.some((a) => a.expired) ? 'bad' : alerts.length ? 'warn' : 'good'} /></div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Routes" className="lg:col-span-2">{R.length === 0 ? <Empty title="No routes yet" hint="Create a route, add its stops with times, then assign students to stops." /> : <table className="tbl"><thead><tr><th>Route</th><th>Vehicle</th><th>Driver</th><th>Stops</th><th>Students / capacity</th></tr></thead><tbody>{R.map((r) => { const n = riders.get(r.id) ?? 0, v = r.vehicle_id ? veh.get(r.vehicle_id) : undefined, cap = v?.capacity ?? 0; return <tr key={r.id}><td><Link className="link font-medium" href={`/erp/x/routes/${r.id}?back=/erp/transport`}>{r.name}</Link><div className="text-xs text-muted">{r.zone}</div></td><td>{v?.reg_no ?? <span className="text-red-600">none</span>}</td><td>{r.driver_id ? dr.name(r.driver_id) : <span className="text-red-600">none</span>}</td><td><Link className="link" href="/erp/x/stops">{r.stops?.[0]?.count ?? 0}</Link></td><td>{n} / {cap || '—'} {cap > 0 && n > cap && <Badge tone="red">over capacity</Badge>}</td></tr>; })}</tbody></table>}</Card>
        <Card title="Document and expiry alerts">{alerts.length === 0 ? <Empty title="Everything is in date" hint="Alerts start 30 days before a vehicle or driver document expires." /> : <ul className="divide-y divide-line text-sm">{alerts.sort((a, b) => a.when.localeCompare(b.when)).map((a, i) => <li key={i} className="flex justify-between gap-2 px-4 py-2"><span>{a.what}</span><Badge tone={a.expired ? 'red' : 'amber'}>{a.expired ? 'expired' : fdate(a.when)}</Badge></li>)}</ul>}</Card>
      </div>
      <Card title="Transport desk" className="mt-4"><div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">{entitiesOf('transport').map((e) => <Link key={e.table} href={`/erp/x/${e.table}`} className="bg-white px-4 py-3 text-sm hover:bg-paper">{e.title}</Link>)}</div></Card>
    </Page>
  );
}
