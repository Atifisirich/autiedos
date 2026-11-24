import { useState } from 'react';
import { View } from 'react-native';
import { addDays, childName, daysBetween, fmtDate, friendlyError, istToday, loadRequests, requestLeave } from '@autoed/shared/erp-portal';
import { supabase } from '../../src/supabase';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Banner, Btn, Card, Failed, Field, Loading, Screen, T, s } from '../../src/ui';

/** Leave requests (dates as YYYY-MM-DD) and their status. Certificates and early pickup are on the web portal for now. */
export default function Requests() {
  const { child, L, lang, boot } = useSession();
  const today = istToday();
  const q = useLoad('requests', () => loadRequests(supabase, child!.id), { child: true });
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  if (!child) return <Screen title={L('requests.title')}><T>{L('home.noChildren')}</T></Screen>;
  const okDates = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && to >= from && from >= addDays(today, -7);
  async function send() {
    if (!boot?.org) return;
    try { await requestLeave(supabase, boot.org.id, { studentId: child!.id, from, to, reason: reason.trim(), days: daysBetween(from, to) + 1 }); setMsg({ tone: 'good', text: L('requests.leaveSent') }); setReason(''); await q.reload(); }
    catch (e) { setMsg({ tone: 'bad', text: friendlyError(e, L('c.error')) }); }
  }
  return (
    <Screen title={L('requests.title')} sub={childName(child)} onRefresh={q.reload} savedAt={q.savedAt}>
      {msg ? <Banner tone={msg.tone} text={msg.text} /> : null}
      <Card title={L('requests.leave')}>
        <Field label={`${L('requests.from')} (YYYY-MM-DD)`} value={from} onChangeText={setFrom} keyboardType="numbers-and-punctuation" />
        <Field label={`${L('requests.to')} (YYYY-MM-DD)`} value={to} onChangeText={setTo} keyboardType="numbers-and-punctuation" />
        <Field label={L('requests.reason')} value={reason} onChangeText={setReason} multiline />
        <Btn disabled={!okDates || !reason.trim()} title={L('requests.sendLeave')} onPress={() => void send()} />
      </Card>
      <Card title={L('requests.history')}>
        {!q.data ? (q.loading ? <Loading /> : <Failed retry={() => void q.reload()} />) : q.data.leaves.length === 0 ? <T>{L('requests.noHistory')}</T> : q.data.leaves.map((l) => (
          <View key={l.id} style={s.row}><T>{fmtDate(l.start_date, lang)}{l.end_date !== l.start_date ? ` – ${fmtDate(l.end_date, lang)}` : ''}</T><T bold>{L(`requests.status.${l.status}`)}</T></View>
        ))}
      </Card>
    </Screen>
  );
}
