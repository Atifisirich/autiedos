'use client';
import { childName, etaMinutes, fmtDate, fmtTime, istToday, loadBus, loadDirectory, mapLink, tripState, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Card, Empty, PageHead } from '@/components/erp-portal/ui';
import { RouteMap } from '@/components/erp-portal/visual';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function Bus() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

function Inner({ child }: { child: Child }) {
  const { sb, L, lang } = usePortal();
  const today = istToday();
  // the position is polled every 10 seconds while the page is open (a lighter load than a socket for one parent)
  const q = useLoad('bus', async () => {
    const dir = await loadDirectory(sb!, child.id);
    const bus = dir.transport ? await loadBus(sb!, child.id, dir.transport.route_id, today) : null;
    return { dir, bus };
  }, [child.id], { childScoped: true, pollMs: 10000 });

  return (
    <>
      <PageHead title={L('bus.title')} sub={childName(child)} />
      <WithData q={q}>
        {({ dir, bus }) => {
          const t = dir.transport;
          if (!t || !bus) return <Card><Empty title={L('bus.noRoute')} /></Card>;
          const state = tripState(bus.trip);
          const has = bus.trip && bus.trip.last_lat !== null && bus.trip.last_lng !== null;
          const pos = has ? { lat: Number(bus.trip!.last_lat), lng: Number(bus.trip!.last_lng) } : null;
          const mine = bus.stops.find((s) => s.name === t.stop);
          const eta = pos && mine?.lat != null && mine.lng != null && state === 'running_live' ? etaMinutes({ ...pos, speed: null }, { lat: Number(mine.lat), lng: Number(mine.lng) }) : null;
          return (
            <div className="space-y-4">
              <Card>
                <div className="flex flex-wrap items-center gap-2">
                  {state === 'running_live' && <Badge tone="good">{L('bus.live')}</Badge>}
                  {state === 'running_stale' && <Badge tone="warn">{bus.trip?.last_at ? L('bus.lastSeen', { time: fmtTime(bus.trip.last_at, lang) }) : L('bus.noPosition')}</Badge>}
                  {state === 'completed' && <Badge>{L('bus.noTrip')}</Badge>}
                  {state === 'none' && <Badge>{L('bus.noTrip')}</Badge>}
                  {bus.trip && state !== 'none' && <span className="text-base text-slate-800">{L(`bus.direction.${bus.trip.direction}`)}</span>}
                  {bus.trip?.delay_minutes ? <Badge tone="bad">{L('bus.late', { n: bus.trip.delay_minutes })}</Badge> : null}
                </div>
                {eta !== null && <p className="mt-2 text-lg font-semibold text-slate-900" data-testid="bus-eta">{L('bus.eta', { n: eta })}</p>}
                {(state === 'running_live' || state === 'running_stale') && (
                  <div className="mt-3 space-y-2">
                    <RouteMap stops={bus.stops} trail={bus.trail.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))} bus={pos} mineId={mine?.id} label={L('bus.title')} />
                    <div className="flex items-center justify-between text-sm text-slate-700">
                      <span>{L('bus.autoRefresh')}</span>
                      {pos && <a href={mapLink(pos.lat, pos.lng)} target="_blank" rel="noopener noreferrer" className="text-base text-[var(--pt-primary)] underline">{L('bus.openMap')}</a>}
                    </div>
                  </div>
                )}
              </Card>

              <Card title={t.route}>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-base">
                  <dt className="text-slate-700">{L('bus.stop')}</dt><dd className="font-semibold">{t.stop ?? '–'}</dd>
                  {t.vehicle && <><dt className="text-slate-700">{L('bus.vehicle')}</dt><dd>{t.vehicle}</dd></>}
                  {t.driver && <><dt className="text-slate-700">{L('bus.driver')}</dt><dd>{t.driver}</dd></>}
                  {t.attendant && <><dt className="text-slate-700">{L('bus.attendant')}</dt><dd>{t.attendant}</dd></>}
                </dl>
                {(t.pickup_time || t.drop_time) && <p className="mt-2 text-base text-slate-800">{t.pickup_time ? L('bus.pickupTime', { time: fmtTime(t.pickup_time, lang) }) : ''}{t.pickup_time && t.drop_time ? ' · ' : ''}{t.drop_time ? L('bus.dropTime', { time: fmtTime(t.drop_time, lang) }) : ''}</p>}
              </Card>

              {bus.events.length > 0 && (
                <Card title={L('bus.today')} flush>
                  <ul className="divide-y divide-slate-100">
                    {bus.events.filter((e) => ['boarded', 'dropped', 'absent', 'delay'].includes(e.type)).map((e) => <li key={e.id} className="flex justify-between px-4 py-3 text-base"><span>{L(`bus.event.${e.type}`)}</span><span className="tabular-nums text-slate-700">{fmtDate(e.at, lang)} {fmtTime(e.at, lang)}</span></li>)}
                  </ul>
                </Card>
              )}
            </div>
          );
        }}
      </WithData>
    </>
  );
}
