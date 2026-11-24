'use client';
import { act, formObj, useCrm } from '@/lib/crm/api';
import { fmtDate, inr, num, pct } from '@/lib/crm/fmt';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '@/components/crm/ui';

type Row = Record<string, any>;
const AUDIENCES: [string, string][] = [
  ['open=1&phase=enquiry', 'Open enquiries (not yet visited)'], ['chip=hot', 'Hot leads'], ['phase=visit&open=1', 'In the visit phase'], ['phase=application&open=1', 'Application in progress'],
  ['phase=prospect', 'Prospect data pool'], ['closed=1&reason=Undecided', 'Closed as undecided'], ['open=1', 'Every open enquiry'],
];
const STEPS: [string, string][] = [['targeted', 'Targeted'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['replied', 'Replied'], ['visits', 'Visits booked'], ['applications', 'Applications'], ['admissions', 'Admissions']];

export default function CampaignsPage() {
  const { data, error, reload } = useCrm<{ campaigns: Row[]; templates: Row[]; views: { name: string; query: string }[]; wallet: number; can: Record<string, any> }>('/campaigns');
  if (error) return <ErrorBox message={error.message} />;
  if (!data) return <Loading />;
  const can = data.can.campaigns;
  return (
    <>
      <PageHeader title="Campaigns" sub="Bulk WhatsApp, SMS and email to a saved audience, with results down to admissions" />
      {can && (
        <form
          className="card mb-4 flex flex-wrap items-end gap-3 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            if (await act('/campaigns', formObj(form))) {
              form.reset();
              reload();
            }
          }}
        >
          <label>
            <span className="label">Campaign name</span>
            <input name="name" required className="input w-56" placeholder="Open house reminder" />
          </label>
          <label>
            <span className="label">Audience</span>
            <select name="audience" className="input w-64">
              {AUDIENCES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
              {data.views.map((v) => (
                <option key={v.name} value={v.query}>
                  Saved view: {v.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Template</span>
            <select name="templateId" required className="input w-64">
              {data.templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.channel}: {x.name} ({x.category})
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary">Create draft</button>
          <p className="muted w-full text-xs">Audiences use the academic year and branch selected in the header. Parents who opted out of a channel are skipped automatically; marketing templates never go to enrolled or closed families.</p>
        </form>
      )}
      {!data.campaigns.length && (
        <div className="card">
          <Empty title="No campaigns yet">Create a draft above, check the audience size and cost estimate, then send.</Empty>
        </div>
      )}
      <div className="space-y-4">
        {data.campaigns.map((c) => (
          <section key={c.id} className="card" aria-label={c.name}>
            <div className="card-h">
              <h2>
                {c.name}{' '}
                <span className="muted font-normal">
                  · {c.channel} · template “{c.template}” · by {c.creator}
                </span>
              </h2>
              {c.status === 'draft' ? <Badge tone="amber">Draft</Badge> : <Badge tone="green">Sent {fmtDate(c.sent_at)}</Badge>}
            </div>
            {c.status === 'draft' ? (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                <p>
                  Audience right now: <b>{num(c.count)}</b> enquiries (one message per family). Estimated cost: up to <b>{inr(c.estimate)}</b> from the wallet (balance {inr(data.wallet)}).
                </p>
                {can && (
                  <div className="flex gap-2">
                    <button
                      className="btn"
                      onClick={async () => {
                        if (window.confirm('Discard this draft?') && (await act(`/campaigns/${c.id}/delete`, {}, { quiet: true }))) reload();
                      }}
                    >
                      Discard
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!c.count}
                      onClick={async () => {
                        if (window.confirm(`Send to ${num(c.count)} enquiries now?`) && (await act(`/campaigns/${c.id}/send`))) reload();
                      }}
                    >
                      Send now to {num(c.count)}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                  {STEPS.filter(([k]) => c.stats[k] !== undefined).map(([k, l]) => (
                    <div key={k} className="rounded-md border border-slate-200 px-3 py-2">
                      <div className="text-xs text-slate-700">{l}</div>
                      <div className="text-lg font-semibold tabular-nums">{num(c.stats[k])}</div>
                      <div className="muted text-[11px]">{k === 'targeted' ? ' ' : pct(c.stats[k], c.stats.targeted) + ' of targeted'}</div>
                    </div>
                  ))}
                </div>
                <p className="muted mt-2 text-xs">
                  Cost {inr(c.cost)}
                  {c.stats.admissions ? ` · ${inr(c.cost / c.stats.admissions)} per admission` : ''}
                  {c.stats.skipped ? ` · ${c.stats.skipped} excluded (enrolled or closed)` : ''}
                </p>
              </div>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
