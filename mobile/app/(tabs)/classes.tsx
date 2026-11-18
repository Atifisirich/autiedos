import { useEffect, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { send } from '../../src/outbox';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Btn, Card, Loading, s, T, colors } from '../../src/ui';

const NEXT: Record<string, string> = { present: 'absent', absent: 'late', late: 'half_day', half_day: 'on_duty', on_duty: 'leave', leave: 'present' };
const TONE: Record<string, string> = { present: '#f0fdf4', absent: '#fee2e2', late: '#fef3c7', half_day: '#fef9c3', on_duty: '#dbeafe', leave: '#f1f5f9' };

interface Section { id: string; name: string; mode: string }

/** Student attendance for teachers: everyone present by default, tap to cycle a status, submit. Works offline. */
export default function Classes() {
  const { t } = useSession();
  const sections = useLoad<Section[]>('/student-attendance/sections');
  const [section, setSection] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const roster = useLoad<{ students: { id: string; full_name: string; roll_no: number; status: string }[]; session: { submitted_at: string | null } | null }>(section ? `/student-attendance/roster?section_id=${section}&date=${today}&session_key=day` : null);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setMarks(Object.fromEntries((roster.data?.students ?? []).map((x) => [x.id, x.status])));
  }, [roster.data]);

  if (!sections.data) return <Loading />;
  if (!section) {
    return (
      <View style={s.screen}>
        <T bold style={{ padding: 14 }}>{t('studentAtt.chooseSection')}</T>
        {sections.data.map((x) => <Card key={x.id} onPress={() => setSection(x.id)}><T bold>{x.name}</T></Card>)}
      </View>
    );
  }
  return (
    <View style={s.screen}>
      <Btn title={t('common.back')} kind="secondary" onPress={() => (setSection(null), setMsg(null))} />
      <T sub style={{ paddingHorizontal: 14 }}>{t('studentAtt.tapHint')}</T>
      {!roster.data ? <Loading /> : (
        <FlatList
          data={roster.data.students}
          keyExtractor={(x) => x.id}
          renderItem={({ item }) => (
            <Pressable onPress={() => setMarks((m) => ({ ...m, [item.id]: NEXT[m[item.id] ?? 'present']! }))} style={{ backgroundColor: TONE[marks[item.id] ?? 'present'], borderColor: colors.border, borderWidth: 1, borderRadius: 10, marginHorizontal: 12, marginVertical: 3, minHeight: 52, padding: 10, justifyContent: 'center' }}>
              <T bold>{item.roll_no}. {item.full_name}</T>
              <T sub>{t(`mark.${marks[item.id] ?? 'present'}`)}</T>
            </Pressable>
          )}
        />
      )}
      {msg && <T sub style={{ padding: 10 }}>{msg}</T>}
      <Btn title={t('common.submit')} onPress={async () => {
        try {
          const r = await send('POST', '/student-attendance', { section_id: section, date: today, session_key: 'day', marks: Object.entries(marks).map(([student_id, status]) => ({ student_id, status })) });
          setMsg(r === 'queued' ? t('status.queued') : t('studentAtt.result.submitted'));
        } catch (e) {
          setMsg(t(`error.${(e as { code?: string }).code ?? 'generic'}`));
        }
      }} />
    </View>
  );
}
