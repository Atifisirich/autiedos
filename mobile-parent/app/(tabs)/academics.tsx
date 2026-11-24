import { useState } from 'react';
import { Linking, View } from 'react-native';
import { childName, fmtDate, loadReportCards, loadResults, resultsByTerm, verifyUrl } from '@autoed/shared/erp-portal';
import { supabase, WEB_BASE } from '../../src/supabase';
import { useSession } from '../../src/session';
import { useLoad } from '../../src/useLoad';
import { Btn, Card, Failed, Loading, Screen, T, s } from '../../src/ui';

/** Report cards (the QR check link is opened in the browser) and published marks. */
export default function Academics() {
  const { child, L, lang } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useLoad('academics', async () => ({ cards: await loadReportCards(supabase, child!.id), results: await loadResults(supabase, child!.id) }), { child: true });
  if (!child) return <Screen title={L('academics.title')}><T>{L('home.noChildren')}</T></Screen>;
  const d = q.data;
  return (
    <Screen title={L('academics.title')} sub={childName(child)} onRefresh={q.reload} savedAt={q.savedAt}>
      {!d ? (q.loading ? <Loading /> : <Failed retry={() => void q.reload()} />) : (
        <>
          <Card title={L('academics.reportCards')}>
            {d.cards.length === 0 ? <T>{L('academics.noCards')}</T> : d.cards.map((c) => (
              <View key={c.id} style={{ gap: 4 }}>
                <T bold>{c.term}</T>{c.published_at ? <T small>{L('academics.published', { date: fmtDate(c.published_at, lang, true) })}</T> : null}
                {c.verify_code && WEB_BASE ? <Btn kind="secondary" disabled={busy === c.id} title={L('academics.verify')} onPress={() => { setBusy(c.id); void Linking.openURL(verifyUrl(WEB_BASE, c.verify_code!)).finally(() => setBusy(null)); }} /> : null}
              </View>
            ))}
          </Card>
          <Card title={L('academics.results')}>
            {d.results.length === 0 ? <T>{L('academics.noResults')}</T> : resultsByTerm(d.results).map((t) => (
              <View key={t.term} style={{ gap: 4 }}>
                {t.term ? <T bold>{t.term}</T> : null}
                {t.subjects.map((sub) => (
                  <View key={sub.name}>
                    <View style={s.row}><T bold>{sub.name || L('homework.general')}</T>{sub.percent !== null ? <T bold>{sub.percent}%</T> : null}</View>
                    {sub.rows.map((r) => <View key={r.assessment_id} style={s.row}><T small>{r.name}</T><T small>{r.code ?? `${r.marks ?? '–'} / ${r.max_marks}`}</T></View>)}
                  </View>
                ))}
              </View>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}
