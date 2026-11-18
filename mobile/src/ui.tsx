import { ActivityIndicator, Pressable, StyleSheet, Text, View, type PressableProps, type TextStyle } from 'react-native';
import type { ReactNode } from 'react';
import { useSession } from './session';

export const colors = { brand: '#1d4ed8', bg: '#f8fafc', card: '#ffffff', border: '#e2e8f0', text: '#0f172a', sub: '#64748b', red: '#b91c1c', green: '#15803d', amber: '#b45309' };

/** Text that follows the "large text" preference. */
export function T({ children, style, bold, sub }: { children: ReactNode; style?: TextStyle; bold?: boolean; sub?: boolean }) {
  const { me } = useSession();
  const big = me?.staff.ui_prefs?.large_text;
  return <Text style={[{ color: sub ? colors.sub : colors.text, fontSize: big ? 19 : 15, fontWeight: bold ? '600' : '400' }, style]}>{children}</Text>;
}

export function Btn({ title, kind = 'primary', ...p }: PressableProps & { title: string; kind?: 'primary' | 'secondary' | 'danger' }) {
  const bg = kind === 'primary' ? colors.brand : kind === 'danger' ? colors.red : '#fff';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} {...p} style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === 'secondary' ? colors.border : bg, opacity: pressed || p.disabled ? 0.6 : 1 }]}>
      <Text style={{ color: kind === 'secondary' ? colors.text : '#fff', fontWeight: '600', fontSize: 15 }}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  const inner = <View style={s.card}>{children}</View>;
  return onPress ? <Pressable onPress={onPress}>{inner}</Pressable> : inner;
}

export function Loading() {
  return <ActivityIndicator style={{ margin: 24 }} color={colors.brand} />;
}

export function Pill({ text, tone = 'gray' }: { text: string; tone?: 'gray' | 'red' | 'green' | 'amber' }) {
  const c = { gray: '#475569', red: colors.red, green: colors.green, amber: colors.amber }[tone];
  return <Text style={{ color: c, borderColor: c, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 1, fontSize: 12, alignSelf: 'flex-start' }}>{text}</Text>;
}

export const s = StyleSheet.create({
  btn: { minHeight: 48, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginVertical: 4 },
  card: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, marginHorizontal: 12, marginVertical: 5, gap: 4 },
  screen: { flex: 1, backgroundColor: colors.bg },
});
