'use client';
/**
 * Floating help button on every screen. Opens the bot with the screen's context.
 * The bot explains and navigates; it never changes data.
 */
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useApp } from '@/lib/app';
import { post } from '@/lib/api';
import { Button, cx } from './ui';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  link?: string | null;
  answerable?: boolean;
  index?: number;
}

export function HelpBot() {
  const { t } = useApp();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [conv, setConv] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [rated, setRated] = useState<Record<number, number>>({});
  const [ticket, setTicket] = useState(false);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const q = text.trim();
    setText('');
    setMsgs((m) => [...m, { role: 'user', content: q }]);
    setBusy(true);
    try {
      const r = await post<{ conversation_id: string; message: Msg; index: number }>('/bot/ask', { conversation_id: conv, message: q, screen_path: pathname });
      setConv(r.conversation_id);
      setMsgs((m) => [...m, { ...r.message, index: r.index }]);
    } catch {
      setMsgs((m) => [...m, { role: 'assistant', content: t('bot.error'), answerable: false }]);
    } finally {
      setBusy(false);
    }
  }

  async function rate(index: number, rating: 1 | -1) {
    if (!conv) return;
    setRated((r) => ({ ...r, [index]: rating }));
    await post('/bot/feedback', { conversation_id: conv, message_index: index, rating }).catch(() => undefined);
  }

  return (
    <div className="no-print fixed bottom-4 right-4 z-40">
      {open && (
        <div className="mb-2 flex h-[480px] w-[min(92vw,380px)] flex-col rounded-xl border bg-white shadow-xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="font-semibold">{t('bot.title')}</span>
            <button onClick={() => setOpen(false)} aria-label={t('common.close')} className="min-h-[32px] min-w-[32px]">
              ×
            </button>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm" aria-live="polite">
            {!msgs.length && <p className="text-slate-500">{t('bot.intro')}</p>}
            {msgs.map((m, i) => (
              <div key={i} className={cx('rounded-lg px-3 py-2', m.role === 'user' ? 'ml-8 bg-brand-50' : 'mr-4 bg-slate-100')}>
                <p className="whitespace-pre-line">{m.content}</p>
                {m.role === 'assistant' && m.link && (
                  <Link href={m.link} className="mt-1 inline-block text-xs font-medium text-brand-700 underline" onClick={() => setOpen(false)}>
                    {t('bot.takeMeThere')}
                  </Link>
                )}
                {m.role === 'assistant' && m.index !== undefined && (
                  <div className="mt-1 flex gap-2 text-xs">
                    <button aria-label={t('bot.helpful')} disabled={!!rated[m.index]} onClick={() => rate(m.index!, 1)}>
                      👍
                    </button>
                    <button aria-label={t('bot.notHelpful')} disabled={!!rated[m.index]} onClick={() => rate(m.index!, -1)}>
                      👎
                    </button>
                  </div>
                )}
                {m.role === 'assistant' && m.answerable === false && conv && !ticket && (
                  <Button size="sm" variant="secondary" className="mt-2" onClick={async () => (await post('/bot/support', { conversation_id: conv }), setTicket(true))}>
                    {t('bot.raiseTicket')}
                  </Button>
                )}
              </div>
            ))}
            {ticket && <p className="text-xs text-green-700">{t('bot.ticketRaised')}</p>}
          </div>
          <form onSubmit={ask} className="flex gap-2 border-t p-2">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('bot.placeholder')} className="min-h-[40px] flex-1 rounded-md border px-2 text-sm" aria-label={t('bot.placeholder')} />
            <VoiceButton onText={(v) => setText(v)} />
            <Button disabled={busy}>{t('bot.send')}</Button>
          </form>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} className="ml-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-xl text-white shadow-lg" aria-label={t('bot.open')}>
        ?
      </button>
    </div>
  );
}

/** Voice input using the browser's speech recognition where available. */
function VoiceButton({ onText }: { onText: (s: string) => void }) {
  const { t, lang } = useApp();
  const SR = typeof window !== 'undefined' ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : null;
  if (!SR) return null;
  return (
    <button
      type="button"
      aria-label={t('bot.voice')}
      className="min-h-[40px] min-w-[40px] rounded-md border"
      onClick={() => {
        const r = new SR();
        r.lang = lang === 'hi' ? 'hi-IN' : lang === 'te' ? 'te-IN' : 'en-IN';
        r.onresult = (e: any) => onText(e.results[0][0].transcript);
        r.start();
      }}
    >
      🎤
    </button>
  );
}
