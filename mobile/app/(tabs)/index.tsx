import * as Location from 'expo-location';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { send } from '../../src/outbox';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Btn, Card, Loading, Pill, s, T } from '../../src/ui';

interface DayItem { kind: string; start: string | null; end: string | null; title: string; status?: string }
interface Day { date: string; holiday: string | null; on_leave: boolean; items: DayItem[]; attendance: { check_in_at: string | null; check_out_at: string | null } | null; pending_approvals: number; unread: number }

export default function MyDay() {
  const { t, me, can } = useSession();
  const day = useLoad<Day>('/my-day');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = day.data;

  const punch = async (kind: 'in' | 'out') => {
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return setMsg(t('error.forbidden'));
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const r = await send('POST', '/attendance/check', { kind, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy ?? undefined, client_at: new Date().toISOString() });
      setMsg(r === 'queued' ? t('status.queued') : t('status.ok'));
      void day.reload();
    } catch (e) {
      setMsg(t(`error.${(e as { code?: string }).code ?? 'generic'}`));
    } finally {
      setBusy(false);
    }
  };

  if (!d) return day.loading ? <Loading /> : <T>{t(`error.${day.error ?? 'generic'}`)}</T>;
  return (
    <ScrollView style={s.screen} refreshControl={<RefreshControl refreshing={day.loading} onRefresh={day.reload} />}>
      <View style={{ padding: 14 }}>
        <T bold style={{ fontSize: 20 }}>{t('myDay.greeting', { name: me?.staff.full_name ?? '' })}</T>
        {day.stale && <Pill text={t('status.queued')} tone="amber" />}
        {d.holiday && <T sub>{t('myDay.holiday')}: {d.holiday}</T>}
        {d.on_leave && <T sub>{t('myDay.onLeave')}</T>}
      </View>
      {can('staff_attendance', 'create') && (
        <Card>
          <T bold>{t('attendance.today')}</T>
          <T sub>{d.attendance?.check_in_at ? `${t('attendance.in')}: ${d.attendance.check_in_at.slice(11, 16)}` : t('attendance.notCheckedIn')}</T>
          {!d.attendance?.check_in_at && <Btn title={t('attendance.checkIn')} disabled={busy} onPress={() => punch('in')} />}
          {d.attendance?.check_in_at && !d.attendance.check_out_at && <Btn title={t('attendance.checkOut')} kind="secondary" disabled={busy} onPress={() => punch('out')} />}
          {msg && <T sub>{msg}</T>}
        </Card>
      )}
      {(d.pending_approvals > 0 || d.unread > 0) && (
        <Card>
          {d.pending_approvals > 0 && <T>{t('myDay.pendingApprovals', { count: d.pending_approvals })}</T>}
          {d.unread > 0 && <T>{t('myDay.unread', { count: d.unread })}</T>}
        </Card>
      )}
      {d.items.map((i, n) => (
        <Card key={n}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T bold>{i.title}</T>
            <T sub>{i.start ? `${i.start.slice(0, 5)}${i.end ? `–${i.end.slice(0, 5)}` : ''}` : t('myDay.anytime')}</T>
          </View>
          <Pill text={t(`myDay.kind.${i.kind}`)} tone={i.kind === 'substitution' ? 'amber' : 'gray'} />
        </Card>
      ))}
      {d.items.length === 0 && <T sub style={{ padding: 16 }}>{t('myDay.empty')}</T>}
    </ScrollView>
  );
}
