import { Linking, View } from 'react-native';
import { childName, etaMinutes, fmtTime, istToday, loadBus, loadDirectory, mapLink, tripState } from '@autoed/shared/erp-portal';
import { supabase } from '../../src/supabase';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Btn, Card, Failed, Loading, Screen, T } from '../../src/ui';

/** Live bus: the position is polled every 10 s while the screen is open; "Open in maps" shows it on the phone's map app. */
export default function Bus() {
  const { child, L, lang } = useSession();
  const q = useLoad('bus', async () => {
    const dir = await loadDirectory(supabase, child!.id);
    return { dir, bus: dir.transport ? await loadBus(supabase, child!.id, dir.transport.route_id, istToday()) : null };
  }, { child: true, pollMs: 10000 });
  if (!child) return <Screen title={L('bus.title')}><T>{L('home.noChildren')}</T></Screen>;
  const d = q.data;
  const t = d?.dir.transport;
  const trip = d?.bus?.trip ?? null;
  const state = tripState(trip);
  const pos = trip && trip.last_lat !== null && trip.last_lng !== null ? { lat: Number(trip.last_lat), lng: Number(trip.last_lng) } : null;
  const mine = d?.bus?.stops.find((x) => x.name === t?.stop);
  const eta = pos && mine?.lat != null && mine.lng != null && state === 'running_live' ? etaMinutes({ ...pos, speed: null }, { lat: Number(mine.lat), lng: Number(mine.lng) }) : null;
  return (
    <Screen title={L('bus.title')} sub={childName(child)} onRefresh={q.reload} savedAt={q.savedAt}>
      {!d ? (q.loading ? <Loading /> : <Failed retry={() => void q.reload()} />) : !t ? <T>{L('bus.noRoute')}</T> : (
        <>
          <Card title={t.route}>
            <T bold color={state === 'running_live' ? '#15803d' : '#b45309'}>{state === 'running_live' ? L('bus.live') : state === 'running_stale' ? (trip?.last_at ? L('bus.lastSeen', { time: fmtTime(trip.last_at, lang) }) : L('bus.noPosition')) : L('bus.noTrip')}</T>
            {trip?.delay_minutes ? <T color="#b91c1c">{L('bus.late', { n: trip.delay_minutes })}</T> : null}
            {eta !== null ? <T bold>{L('bus.eta', { n: eta })}</T> : null}
            {pos ? <Btn kind="secondary" title={L('bus.openMap')} onPress={() => void Linking.openURL(mapLink(pos.lat, pos.lng))} /> : null}
          </Card>
          <Card><View style={{ gap: 2 }}>
            <T>{L('bus.stop')}: {t.stop ?? '–'}</T>
            {t.vehicle ? <T>{L('bus.vehicle')}: {t.vehicle}</T> : null}
            {t.driver ? <T>{L('bus.driver')}: {t.driver}</T> : null}
          </View></Card>
        </>
      )}
    </Screen>
  );
}
