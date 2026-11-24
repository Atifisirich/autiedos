import { View } from 'react-native';
import { addDays, attendanceSummary, attendanceTone, childName, fmtDate, istToday, loadMarks } from '@autoed/shared/erp-portal';
import { supabase } from '../../src/supabase';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Card, Failed, Loading, Screen, T, s } from '../../src/ui';

const COLOR = { good: '#15803d', bad: '#b91c1c', warn: '#b45309', info: '#0369a1', none: '#475569' };

export default function Attendance() {
  const { child, L, lang } = useSession();
  const q = useLoad('attendance', () => loadMarks(supabase, child!.id, addDays(istToday(), -120)), { child: true });
  if (!child) return <Screen title={L('attendance.title')}><T>{L('home.noChildren')}</T></Screen>;
  const sum = q.data ? attendanceSummary(q.data) : null;
  return (
    <Screen title={L('attendance.title')} sub={childName(child)} onRefresh={q.reload} savedAt={q.savedAt}>
      {!q.data ? (q.loading ? <Loading /> : <Failed retry={() => void q.reload()} />) : q.data.length === 0 ? <T>{L('attendance.none')}</T> : (
        <>
          <Card title={L('attendance.percent')}><T bold>{sum?.percent === null ? '–' : `${sum?.percent}%`}</T><T small>{L('attendance.days', { n: sum?.total ?? 0 })}</T></Card>
          <Card title={L('attendance.recent')}>
            {q.data.slice(0, 30).map((m) => <View key={m.date} style={s.row}><T>{fmtDate(m.date, lang, true)}</T><T bold color={COLOR[attendanceTone(m.status)]}>{L(`att.${m.status}`)}</T></View>)}
          </Card>
        </>
      )}
    </Screen>
  );
}
