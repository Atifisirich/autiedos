import { createHmac } from 'node:crypto';
import { userClient } from '@/lib/erp/db';
import { fdate } from '@/lib/erp/fmt';
import { PRODUCT } from '@/lib/erp/nav';
import '@/components/erp/erp.css';

export const metadata = { title: 'Verify a document' };
export const dynamic = 'force-dynamic';

/**
 * Server-only token for the public check. erp.verify_document is granted to the erp_server role only (nothing is granted to anon), so this
 * page signs a short-lived token for that role with the secret the Data API verifies. The secret lives only in the server environment
 * (ERP_JWT_SECRET, or a ready token in ERP_SERVER_TOKEN) and the token is used for this one function call.
 */
function serverToken() {
  if (process.env.ERP_SERVER_TOKEN) return process.env.ERP_SERVER_TOKEN;
  const secret = process.env.ERP_JWT_SECRET;
  if (!secret) return null;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ role: 'erp_server', iat: now, exp: now + 60 });
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

/** Public page behind the QR code on certificates and report cards. */
export default async function Verify({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const token = serverToken();
  type Doc = { type: string; title: string; number: string; status: string; issued_on: string; school: string; student: string };
  let d = null as Doc | null;
  if (token && /^[A-Za-z0-9-]{6,64}$/.test(code)) {
    const sb = userClient(token);
    const r = await sb.schema('erp').rpc('verify_document', { p_code: code });
    d = (r.data ?? null) as Doc | null;
  }
  const good = d && (d.status === 'issued' || d.status === 'published');
  return (
    <div className="erp">
      <div className="mx-auto max-w-md px-6 py-16">
        <div className={`card p-6 text-center ${good ? 'border-emerald-300' : 'border-red-300'}`}>
          <div className={`text-lg font-semibold ${good ? 'text-emerald-700' : 'text-red-700'}`}>{good ? 'Genuine document' : d ? 'This document has been revoked' : 'No document matches this code'}</div>
          {d && (
            <dl className="mt-4 space-y-1.5 text-left text-sm">
              {[['School', d.school], ['Document', `${String(d.type).replace(/_/g, ' ')}${d.title ? ` · ${d.title}` : ''}`], ['Number', d.number], ['Issued to', d.student], ['Issued on', fdate(d.issued_on)]].filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4"><dt className="text-muted">{k}</dt><dd className="text-right font-medium">{v}</dd></div>
              ))}
            </dl>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-muted">Verified by {PRODUCT.name}</p>
      </div>
    </div>
  );
}
