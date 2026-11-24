'use client';
import { use, useEffect, useState } from 'react';
import { fmtDate } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { Card, Notice, Spinner } from '@/components/erp-portal/ui';
import { LanguageSelect } from '@/components/erp-portal/shell';

interface Result { valid: boolean; type?: string; title?: string; number?: string; status?: string; issued_on?: string; school?: string; student?: string; kind?: string }

/** Public page behind the QR code of a report card or certificate: anyone with the link can check that the school issued it. No sign-in. */
export default function Verify({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = use(params);
  const code = decodeURIComponent(raw);
  const { L, lang } = usePortal();
  const [state, setState] = useState<'loading' | 'done' | 'down'>('loading');
  const [res, setRes] = useState<Result | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(`/api/erp-portal/verify?code=${encodeURIComponent(code)}`, { cache: 'no-store' }).then(async (r) => {
      if (!alive) return;
      if (r.status === 404) { setRes({ valid: false }); setState('done'); }
      else if (!r.ok) setState('down');
      else { setRes((await r.json()) as Result); setState('done'); }
    }).catch(() => alive && setState('down'));
    return () => { alive = false; };
  }, [code]);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-8">
      <div className="flex items-center justify-between gap-2"><h1 className="text-2xl font-bold text-slate-900">{L('verify.title')}</h1><LanguageSelect /></div>
      {state === 'loading' && <Spinner label={L('verify.checking')} />}
      {state === 'down' && <Notice tone="bad">{L('verify.unavailable')}</Notice>}
      {state === 'done' && res && !res.valid && <Notice tone="bad">{L('verify.invalid')}</Notice>}
      {state === 'done' && res?.valid && (
        <Card>
          <Notice tone="good"><span className="text-lg font-semibold" data-testid="verify-valid">{L('verify.valid')}</span></Notice>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
            <dt className="text-slate-700">{L('verify.school')}</dt><dd className="font-semibold" data-testid="verify-school">{res.school}</dd>
            <dt className="text-slate-700">{L('verify.student')}</dt><dd>{res.student}</dd>
            <dt className="text-slate-700">{L('verify.type')}</dt><dd>{res.title ?? res.type}{res.number ? ` ${res.number}` : ''}</dd>
            {res.issued_on && <><dt className="text-slate-700">{L('verify.issued')}</dt><dd>{fmtDate(res.issued_on, lang, true)}</dd></>}
            {res.status && <><dt className="text-slate-700">{L('verify.status')}</dt><dd>{res.status}</dd></>}
            <dt className="text-slate-700">{L('verify.code')}</dt><dd className="break-all text-sm">{code}</dd>
          </dl>
        </Card>
      )}
    </div>
  );
}
