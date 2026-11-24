'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { driverEnd, driverMark, driverPosition, driverRoutes, driverStart, driverStudents, fmtTime, friendlyError, type DriverRoute, type DriverStudent } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { Badge, Btn, Card, Empty, Input, Notice, PageHead, Spinner } from '@/components/erp-portal/ui';

type Gps = 'off' | 'starting' | 'on' | 'denied' | 'unsupported';

/**
 * Driver and attendant screen: pick the route, start a trip, keep the page open while driving. The phone's position is posted
 * through erp.driver_position (at most every 10 s), boarding and drop-off are marked per child, SOS and "running late" notify the
 * school and the parents of the route. Nothing is stored on the device: this screen needs a connection.
 */
export default function Driver() {
  const { sb, L, lang } = usePortal();
  const [routes, setRoutes] = useState<DriverRoute[] | null>(null);
  const [active, setActive] = useState<{ trip: string; route: DriverRoute } | null>(null);
  const [students, setStudents] = useState<DriverStudent[]>([]);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [gps, setGps] = useState<Gps>('off');
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [delay, setDelay] = useState('10');
  const lastRef = useRef(0);
  const posRef = useRef<{ lat: number; lng: number } | null>(null);

  const loadRoutes = useCallback(async () => {
    if (!sb) return;
    try { setRoutes(await driverRoutes(sb)); } catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); setRoutes([]); }
  }, [sb, L]);
  useEffect(() => { void loadRoutes(); }, [loadRoutes]);

  const refreshStudents = useCallback(async (trip: string) => { if (sb) try { setStudents(await driverStudents(sb, trip)); } catch { /* keep the last list */ } }, [sb]);

  // GPS while a trip is active
  useEffect(() => {
    if (!active || !sb) return;
    if (!('geolocation' in navigator)) { setGps('unsupported'); return; }
    setGps('starting');
    let wake: { release: () => Promise<void> } | null = null;
    void (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => undefined);
    const id = navigator.geolocation.watchPosition(
      (p) => {
        posRef.current = { lat: p.coords.latitude, lng: p.coords.longitude };
        setGps('on');
        if (Date.now() - lastRef.current < 10000) return;
        lastRef.current = Date.now();
        void driverPosition(sb, active.trip, p.coords.latitude, p.coords.longitude, p.coords.speed !== null ? Math.round(p.coords.speed * 3.6 * 10) / 10 : null)
          .then(() => setLastSent(new Date().toISOString())).catch(() => undefined);
      },
      (err) => setGps(err.code === err.PERMISSION_DENIED ? 'denied' : 'starting'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => { navigator.geolocation.clearWatch(id); void wake?.release(); };
  }, [active, sb]);

  async function start(r: DriverRoute, direction: 'pickup' | 'drop') {
    setBusy(true); setMsg(null);
    try { const trip = await driverStart(sb!, r.id, direction); setActive({ trip, route: r }); await refreshStudents(trip); }
    catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
    finally { setBusy(false); }
  }
  async function resume(r: DriverRoute) {
    if (!r.running_trip) return;
    setActive({ trip: r.running_trip, route: r });
    await refreshStudents(r.running_trip);
  }
  async function mark(student: string | null, type: 'boarded' | 'dropped' | 'absent' | 'sos' | 'delay', note?: string) {
    if (!active) return;
    setBusy(true); setMsg(null);
    try {
      await driverMark(sb!, active.trip, student, type, posRef.current, note);
      if (type === 'sos') setMsg({ tone: 'good', text: L('driver.sosSent') });
      if (type === 'delay') setMsg({ tone: 'good', text: L('driver.delaySent') });
      await refreshStudents(active.trip);
    } catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
    finally { setBusy(false); }
  }
  async function end() {
    if (!active || !window.confirm(L('driver.endConfirm'))) return;
    setBusy(true);
    try { await driverEnd(sb!, active.trip); setActive(null); setGps('off'); setMsg({ tone: 'good', text: L('driver.ended') }); await loadRoutes(); }
    catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
    finally { setBusy(false); }
  }

  if (!routes) return <Spinner label={L('c.loading')} />;
  return (
    <>
      <PageHead title={active ? active.route.name : L('driver.title')} sub={active?.route.vehicle ? L('driver.vehicle', { reg: active.route.vehicle }) : undefined} />
      {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}

      {!active && (
        routes.length === 0 ? <Card><Empty title={L('driver.noRoutes')} /></Card> : (
          <ul className="space-y-3" aria-label={L('driver.routes')}>
            {routes.map((r) => (
              <li key={r.id}>
                <Card title={r.name} actions={r.running_trip ? <Badge tone="good">{L('driver.running')}</Badge> : undefined}>
                  <p className="mb-3 text-base text-slate-700">{r.vehicle ? L('driver.vehicle', { reg: r.vehicle }) : ''}</p>
                  {r.running_trip ? <Btn className="w-full" onClick={() => void resume(r)}>{L('driver.resume')}</Btn> : (
                    <div className="grid gap-2 sm:grid-cols-2"><Btn disabled={busy} onClick={() => void start(r, 'pickup')}>{L('driver.startPickup')}</Btn><Btn variant="secondary" disabled={busy} onClick={() => void start(r, 'drop')}>{L('driver.startDrop')}</Btn></div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )
      )}

      {active && (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone={gps === 'on' ? 'good' : gps === 'denied' || gps === 'unsupported' ? 'bad' : 'warn'}>{gps === 'on' ? L('driver.gps.on') : gps === 'denied' ? L('driver.gps.denied') : gps === 'unsupported' ? L('driver.gps.unsupported') : L('driver.gps.starting')}</Badge>
              {lastSent && <span className="text-sm text-slate-700" data-testid="gps-last">{L('driver.gps.last', { time: fmtTime(lastSent, lang) })}</span>}
            </div>
            <p className="mt-2 text-sm text-slate-700">{L('driver.keepOpen')}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Btn variant="danger" disabled={busy} onClick={() => { if (window.confirm(L('driver.sosConfirm'))) void mark(null, 'sos', 'SOS'); }}>{L('driver.sos')}</Btn>
              <Btn variant="secondary" disabled={busy} onClick={() => void end()}>{L('driver.end')}</Btn>
            </div>
            <form className="mt-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void mark(null, 'delay', delay); }}>
              <div className="flex-1"><Input label={L('driver.delayMinutes')} type="number" inputMode="numeric" min={1} max={180} value={delay} onChange={(e) => setDelay(e.target.value)} /></div>
              <Btn type="submit" variant="secondary" disabled={busy || !delay}>{L('driver.delay')}</Btn>
            </form>
          </Card>
          <Card title={L('driver.students')} flush>
            {students.length === 0 ? <Empty title={L('c.empty')} /> : (
              <ul className="divide-y divide-slate-100" data-testid="driver-students">
                {students.map((s) => (
                  <li key={s.student_id} className="space-y-2 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-base font-semibold text-slate-900">{s.name}</span><span className="text-sm text-slate-700">{s.stop}{s.last_event ? ` · ${L('driver.last', { event: s.last_event })}` : ''}</span></div>
                    <div className="grid grid-cols-3 gap-2">
                      <Btn variant={s.last_event === 'boarded' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void mark(s.student_id, 'boarded')}>{L('driver.board')}</Btn>
                      <Btn variant={s.last_event === 'dropped' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void mark(s.student_id, 'dropped')}>{L('driver.drop')}</Btn>
                      <Btn variant="ghost" disabled={busy} onClick={() => void mark(s.student_id, 'absent')}>{L('driver.absent')}</Btn>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
