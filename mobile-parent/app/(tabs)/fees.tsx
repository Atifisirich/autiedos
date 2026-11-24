import { Linking, View } from 'react-native';
import { childName, demandBalance, demandState, demandTotal, feeSummary, fmtDate, inr, istToday, loadFees } from '@autoed/shared/erp-portal';
import { supabase, WEB_BASE } from '../../src/supabase';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Btn, Card, Failed, Loading, Screen, T, s } from '../../src/ui';

/** Fees view. Paying opens the school's web portal (order + checkout), so the mobile app holds no payment code. */
export default function Fees() {
  const { child, L, lang } = useSession();
  const today = istToday();
  const q = useLoad('fees', () => loadFees(supabase, child!.id), { child: true });
  if (!child) return <Screen title={L('fees.title')}><T>{L('home.noChildren')}</T></Screen>;
  const d = q.data;
  const fs = d ? feeSummary(d.demands, today) : null;
  return (
    <Screen title={L('fees.title')} sub={childName(child)} onRefresh={q.reload} savedAt={q.savedAt}>
      {!d ? (q.loading ? <Loading /> : <Failed retry={() => void q.reload()} />) : (
        <>
          <Card title={L('fees.due')}><T bold>{inr(fs?.due)}</T>{fs && fs.overdue > 0 ? <T color="#b91c1c">{L('home.overdueOf', { amount: inr(fs.overdue) })}</T> : null}</Card>
          {fs && fs.due > 0 && WEB_BASE ? <Btn title={L('fees.paySelected', { amount: inr(fs.due) })} onPress={() => void Linking.openURL(`${WEB_BASE}/erp/parent/fees`)} /> : null}
          <Card title={L('fees.instalments')}>
            {d.demands.length === 0 ? <T>{L('fees.noFees')}</T> : d.demands.map((x) => (
              <View key={x.id} style={s.row}>
                <View style={{ flex: 1 }}><T bold>{`${x.head ?? ''} ${x.label ?? ''}`.trim()}</T><T small color="#475569">{L('fees.dueOn', { date: fmtDate(x.due_date, lang, true) })} · {L(`fees.state.${demandState(x, today)}`)}</T></View>
                <View><T>{inr(demandTotal(x))}</T><T small bold>{L('fees.balance')} {inr(demandBalance(x))}</T></View>
              </View>
            ))}
          </Card>
          <Card title={L('fees.receipts')}>
            {d.receipts.length === 0 ? <T>{L('fees.noReceipts')}</T> : d.receipts.map((r) => <View key={r.id} style={s.row}><T>{L('fees.receiptNo', { no: r.receipt_no })} · {fmtDate(r.date, lang)}</T><T>{inr(r.total)}</T></View>)}
          </Card>
        </>
      )}
    </Screen>
  );
}
