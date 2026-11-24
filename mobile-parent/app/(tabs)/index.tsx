import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { addDays, attendanceTone, childName, feeSummary, fmtDate, inr, istToday, loadCirculars, loadDirectory, loadFees, loadMarks, nextActions } from '@autoed/shared/erp-portal';
import { supabase } from '../../src/supabase';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Card, Failed, Loading, Screen, T, s } from '../../src/ui';

export default function Home() {
  const { child, L, lang, session } = useSession();
  const router = useRouter();
  const today = istToday();
  const q = useLoad('home', async () => {
    const [marks, fees, dir, circ] = await Promise.all([loadMarks(supabase, child!.id, addDays(today, -7)), loadFees(supabase, child!.id), loadDirectory(supabase, child!.id), loadCirculars(supabase, session!.user.id)]);
    return { marks, fees, dir, circ };
  }, { child: true });
  if (!child) return <Screen title={L('home.noChildren')}><T>{L('home.noChildrenHint')}</T></Screen>;
  const d = q.data;
  const fs = d ? feeSummary(d.fees.demands, today) : null;
  const mark = d?.marks.find((m) => m.date === today);
  const actions = d && fs ? nextActions({ overdue: fs.overdue, approvedPasses: 0, unread: d.circ.filter((c) => !c.read_at).length, openTests: 0, homeworkDueSoon: 0, openPtmSlots: 0, bookedPtm: false }) : [];
  const links = [['attendance', 'nav.attendance'], ['homework', 'nav.homework'], ['bus', 'nav.bus'], ['requests', 'nav.requests']] as const;
  return (
    <Screen title={childName(child)} sub={`${d?.dir.section ?? ''} · ${fmtDate(today, lang, true)}`} onRefresh={q.reload} savedAt={q.savedAt}>
      {!d ? (q.loading ? <Loading /> : <Failed retry={() => void q.reload()} />) : (
        <>
          <Card title={L('home.attendanceToday')}><T bold color={attendanceTone(mark?.status) === 'bad' ? '#b91c1c' : undefined}>{mark ? L(`att.${mark.status}`) : L('att.notMarked')}</T></Card>
          <Card title={L('home.feesDue')}><T bold>{inr(fs?.due)}</T>{fs && fs.overdue > 0 ? <T color="#b91c1c">{L('home.overdueOf', { amount: inr(fs.overdue) })}</T> : null}</Card>
          {actions.length > 0 && <Card title={L('home.nextActions')}>{actions.map((a) => <T key={a.key} bold>{L(`action.${a.key}`, { amount: inr(fs?.overdue), n: a.count })}</T>)}</Card>}
          {d.dir.class_teacher ? <T small color="#475569">{L('home.classTeacher', { name: d.dir.class_teacher.name })}</T> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {links.filter(([k]) => k !== 'bus' || d.dir.transport).map(([k, label]) => (
              <Pressable key={k} accessibilityRole="button" onPress={() => router.push(`/(tabs)/${k}` as never)} style={[s.card, { minWidth: '47%', minHeight: 52, justifyContent: 'center', alignItems: 'center' }]}><T bold>{L(label)}</T></Pressable>
            ))}
          </View>
        </>
      )}
    </Screen>
  );
}
