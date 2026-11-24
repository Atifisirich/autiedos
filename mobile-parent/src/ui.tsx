import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, RefreshControl, type TextInputProps } from 'react-native';
import { useState, type ReactNode } from 'react';
import { fmtDate, fmtTime } from '@autoed/shared/erp-portal';
import { useSession } from './session';

export const ink = '#0f172a';
export const sub = '#475569';

export function T({ children, bold, small, color, style }: { children: ReactNode; bold?: boolean; small?: boolean; color?: string; style?: object }) {
  return <Text style={[{ color: color ?? ink, fontSize: small ? 13 : 16, fontWeight: bold ? '700' : '400' }, style]}>{children}</Text>;
}

/** Filled with the school's colour (decision 46). */
export function Btn({ title, onPress, disabled, kind = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'danger' }) {
  const { brand } = useSession();
  const bg = kind === 'primary' ? brand.primary : kind === 'danger' ? '#b91c1c' : '#fff';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === 'secondary' ? '#94a3b8' : bg, opacity: pressed || disabled ? 0.6 : 1 }]}>
      <Text style={{ color: kind === 'primary' ? brand.onPrimary : kind === 'danger' ? '#fff' : ink, fontWeight: '700', fontSize: 16 }}>{title}</Text>
    </Pressable>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return <View style={s.card}>{title ? <T bold>{title}</T> : null}{children}</View>;
}

export function Field({ label, ...p }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 4 }}>
      <T bold small>{label}</T>
      <TextInput accessibilityLabel={label} placeholderTextColor="#64748b" {...p} style={s.input} />
    </View>
  );
}

export function Banner({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warn' | 'bad' | 'good' }) {
  const bg = { info: '#e0f2fe', warn: '#fef3c7', bad: '#fee2e2', good: '#dcfce7' }[tone];
  return <View accessibilityLiveRegion="polite" style={[s.banner, { backgroundColor: bg }]}><T small>{text}</T></View>;
}

export function Screen({ title, sub: subtitle, children, onRefresh, savedAt }: { title: string; sub?: string; children: ReactNode; onRefresh?: () => Promise<unknown>; savedAt?: number | null }) {
  const { brand, L, lang, offline } = useSession();
  const [spin, setSpin] = useState(false);
  const when = savedAt ? `${fmtDate(new Date(savedAt).toISOString(), lang)} ${fmtTime(new Date(savedAt).toISOString(), lang)}` : '';
  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#f8fafc' }} contentContainerStyle={{ padding: 12, gap: 10 }}
      refreshControl={onRefresh ? <RefreshControl refreshing={spin} onRefresh={() => { setSpin(true); void onRefresh().finally(() => setSpin(false)); }} tintColor={brand.primary} /> : undefined}>
      <View><Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: '800', color: ink }}>{title}</Text>{subtitle ? <T color={sub}>{subtitle}</T> : null}</View>
      {(savedAt || offline) ? <Banner tone="warn" text={L('c.offline', { when })} /> : null}
      {children}
    </ScrollView>
  );
}

export const Loading = () => <ActivityIndicator style={{ margin: 24 }} />;
export function Failed({ retry }: { retry: () => void }) { const { L } = useSession(); return <Card><Banner tone="bad" text={L('c.error')} /><Btn kind="secondary" title={L('c.retry')} onPress={retry} /></Card>; }

export const s = StyleSheet.create({
  btn: { minHeight: 48, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginVertical: 4 },
  card: { backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: '#e2e8f0', padding: 14, gap: 6 },
  input: { minHeight: 48, borderWidth: 2, borderColor: '#cbd5e1', borderRadius: 12, paddingHorizontal: 12, fontSize: 16, color: ink, backgroundColor: '#fff' },
  banner: { borderRadius: 10, padding: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 40 },
});
