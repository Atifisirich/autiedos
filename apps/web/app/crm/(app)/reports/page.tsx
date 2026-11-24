'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { flash, useCrm } from '@/lib/crm/api';
import { inr, num, pct } from '@/lib/crm/fmt';
import { Bars, Empty, ErrorBox, Loading, Meter, PageHeader, Stat } from '@/components/crm/ui';

type Row = Record<string, any>;
type Res = {
  kpis: Row; phases: Row[]; seats: Row[]; branches: Row[]; sources: Row[]; team: Row[]; reasons: Row[]; ageing: Row[]; byFields: { key: string; label: string }[]; byField: { key: string; label: string } | null; byRows: Row[];
  showCost: boolean; showTeam: boolean; year: string; branchName: string | null;
};

export default function ReportsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Reports />
    </Suspense>
  );
}

async function download(path: string, query: Record<string, string>) {
  const res = await fetch(`/api/crm${path}?${new URLSearchParams(query)}`);
  if (!res.ok) return flash('Could not export.', 'error');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Role dashboards and the standard report set (REP-01..03, KPI definitions in PRD section 16).
 * Every number links to the records behind it; everything follows the year and branch in the header.
 */
function Reports() {
  const by = useSearchParams().get('by') ?? '';
  const { data: r, error } = useCrm<Res>('/reports', { by });
  if (error) return <ErrorBox message={error.message} />;
  if (!r) return <Loading />;
  const K = r.kpis;
  const enc = encodeURIComponent;
  return (
    <>
      <PageHeader title="Reports" sub={`${r.year}${r.branchName ? ' · ' + r.branchName : ' · all your branches'} · live data. Click any number to see the records behind it.`}>
        <button className="btn" onClick={() => download('/export', { open: '1' })}>
          Export open enquiries (CSV)
        </button>
      </PageHeader>
      {!K.enquiries && !K.admitted ? (
        <div className="card">
          <Empty title="No enquiries in this year yet">Reports fill in as enquiries arrive. Switch the academic year in the header to see another season.</Empty>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Enquiries" value={num(K.enquiries)} href="/crm/leads" />
            <Stat label="Contact rate" value={pct(K.contacted, K.enquiries)} sub="two-way conversation" href="/crm/leads?contacted=1" />
            <Stat label="Enquiry to visit" value={pct(K.visited, K.enquiries)} href="/crm/leads?visited=1" />
            <Stat label="Visit to application" value={pct(K.visited_applied, K.visited)} href="/crm/leads?visited_applied=1" />
            <Stat label="Application to admission" value={pct(K.admitted, K.applied)} href="/crm/leads?won=1" />
            <Stat label="Overall conversion" value={pct(K.admitted, K.enquiries)} tone="good" href="/crm/leads?won=1" />
            <Stat label="Median first response" value={K.median_first_response != null ? `${Math.round(K.median_first_response)} min` : '–'} sub="last 60 days" tone={K.median_first_response > 30 ? 'bad' : undefined} />
            <Stat label="Follow-up compliance" value={pct(K.followup_ontime, K.followup_due)} sub="tasks done by due day" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card" aria-label="By phase">
              <div className="card-h">
                <h2>Where enquiries stand now, by phase</h2>
              </div>
              <div className="p-4">
                <Bars rows={r.phases.map((p) => ({ label: p.name, value: p.n, href: `/crm/leads?phase=${p.key}` }))} />
              </div>
            </section>
            <section className="card" aria-label="Admissions forecast">
              <div className="card-h">
                <h2>Admissions forecast</h2>
              </div>
              <div className="grid grid-cols-3 gap-3 p-4">
                <Stat label="Confirmed" value={K.admitted} href="/crm/leads?won=1" />
                <Stat label="Forecast" value={K.forecast} sub="confirmed + open × stage probability" />
                <Stat label="Seats" value={num(K.capacity)} sub={`${pct(K.admitted, K.capacity)} filled`} />
              </div>
              <p className="muted px-4 pb-4 text-xs">
                {K.open} open enquiries carry a weighted {Number(K.weighted).toFixed(1)} expected admissions. Stage probabilities are set in Admin › Pipeline. Re-enquiry rate: {pct(K.reenquired, K.enquiries)}.
              </p>
            </section>
          </div>

          <section className="card overflow-x-auto" aria-label="Seats against admissions">
            <div className="card-h">
              <h2>Seats against admissions, by grade</h2>
              <button className="btn btn-sm" onClick={() => download('/reports/export', { table: 'seats' })}>
                CSV
              </button>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Grade</th>
                  <th>Capacity</th>
                  <th>Confirmed</th>
                  <th>Seat fill</th>
                  <th>In application to offer</th>
                  <th>Seats left</th>
                </tr>
              </thead>
              <tbody>
                {r.seats.map((s) => (
                  <tr key={s.grade}>
                    <td className="font-medium">{s.grade}</td>
                    <td>{s.capacity}</td>
                    <td>
                      <Link className="link" href={`/crm/leads?grade=${enc(s.grade)}&won=1`}>
                        {s.confirmed}
                      </Link>
                    </td>
                    <td>
                      <Meter value={s.confirmed} max={s.capacity} />
                    </td>
                    <td>
                      <Link className="link" href={`/crm/leads?grade=${enc(s.grade)}&open=1`}>
                        {s.pipeline}
                      </Link>
                    </td>
                    <td className={s.capacity - s.confirmed <= 0 ? 'font-semibold text-rose-700' : ''}>{s.capacity - s.confirmed <= 0 ? 'Full' : s.capacity - s.confirmed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            {r.branches.length > 1 && (
              <section className="card overflow-x-auto" aria-label="Branch comparison">
                <div className="card-h">
                  <h2>Branch comparison</h2>
                  <button className="btn btn-sm" onClick={() => download('/reports/export', { table: 'branches' })}>
                    CSV
                  </button>
                </div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Branch</th>
                      <th>Enquiries</th>
                      <th>Visited</th>
                      <th>Enquiry to visit</th>
                      <th>Admitted</th>
                      <th>Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.branches.map((b) => (
                      <tr key={b.id}>
                        <td className="font-medium">{b.name}</td>
                        <td>
                          <Link className="link" href={`/crm/leads?branch=${b.id}`}>
                            {b.enquiries}
                          </Link>
                        </td>
                        <td>{b.visited}</td>
                        <td>{pct(b.visited, b.enquiries)}</td>
                        <td>{b.admitted}</td>
                        <td>{pct(b.admitted, b.enquiries)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            {r.byFields.length > 0 && (
              <section className="card overflow-x-auto" aria-label="Conversion by field">
                <div className="card-h">
                  <h2>Conversion by {r.byField?.label ?? 'field'}</h2>
                  <form className="flex gap-1" method="get" action="/crm/reports">
                    <select name="by" defaultValue={r.byField?.key} className="input !py-1 text-xs" aria-label="Break down by">
                      {r.byFields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <button className="btn btn-sm">Show</button>
                  </form>
                </div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{r.byField?.label}</th>
                      <th>Enquiries</th>
                      <th>Visited</th>
                      <th>Admitted</th>
                      <th>Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byRows.map((x) => (
                      <tr key={x.v}>
                        <td className="font-medium">{x.v}</td>
                        <td>
                          <Link className="link" href={x.v === 'Not filled' ? '/crm/leads' : `/crm/leads?cf_${r.byField!.key}=${enc(x.v)}`}>
                            {x.enquiries}
                          </Link>
                        </td>
                        <td>{x.visited}</td>
                        <td>{x.admitted}</td>
                        <td>{pct(x.admitted, x.enquiries)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            <section className="card" aria-label="Why enquiries closed">
              <div className="card-h">
                <h2>Why enquiries closed</h2>
                <button className="btn btn-sm" onClick={() => download('/reports/export', { table: 'reasons' })}>
                  CSV
                </button>
              </div>
              <div className="p-4">{r.reasons.length ? <Bars rows={r.reasons.map((x) => ({ label: x.reason, value: x.n, href: `/crm/leads?closed=1&reason=${enc(x.reason)}` }))} /> : <p className="muted">Nothing closed this year.</p>}</div>
            </section>
            <section className="card" aria-label="Untouched enquiries">
              <div className="card-h">
                <h2>Untouched enquiries, by how long they have waited</h2>
              </div>
              <div className="p-4">{r.ageing.length ? <Bars rows={r.ageing.map((x) => ({ label: x.label, value: x.n, href: `/crm/leads?wait=${x.bucket}` }))} /> : <p className="muted">Every enquiry has had a first response.</p>}</div>
            </section>
          </div>

          <section className="card overflow-x-auto" aria-label="Sources">
            <div className="card-h">
              <h2>Sources: first-touch channel{r.showCost ? ', with cost' : ''}</h2>
              <button className="btn btn-sm" onClick={() => download('/reports/export', { table: 'sources' })}>
                CSV
              </button>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Leads</th>
                  <th>Visits</th>
                  <th>Admissions</th>
                  <th>Lead to admission</th>
                  {r.showCost && (
                    <>
                      <th>Spend</th>
                      <th>Cost per lead</th>
                      <th>Cost per admission</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {r.sources.map((s) => (
                  <tr key={s.channel}>
                    <td className="font-medium">{s.channel}</td>
                    <td>
                      <Link className="link" href={`/crm/leads?channel=${enc(s.channel)}`}>
                        {s.leads}
                      </Link>
                    </td>
                    <td>{s.visits}</td>
                    <td>{s.admissions}</td>
                    <td>{pct(s.admissions, s.leads)}</td>
                    {r.showCost && (
                      <>
                        <td>{s.cost ? inr(s.cost) : '–'}</td>
                        <td>{s.cost ? inr(s.cost / s.leads) : '–'}</td>
                        <td>{s.cost && s.admissions ? inr(s.cost / s.admissions) : '–'}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {r.showCost && <p className="muted px-4 py-2 text-xs">Spend is the season total entered per source in Admin › Sources. It is not prorated to the selected branch.</p>}
          </section>

          {r.showTeam && (
            <section className="card overflow-x-auto" aria-label="Counsellors">
              <div className="card-h">
                <h2>Counsellors: outcomes and effort</h2>
                <button className="btn btn-sm" onClick={() => download('/reports/export', { table: 'team' })}>
                  CSV
                </button>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Counsellor</th>
                    <th>Open</th>
                    <th>Admissions</th>
                    <th>Conversion</th>
                    <th>Calls, 7 days</th>
                    <th>Connected</th>
                    <th>Visits hosted, 30 days</th>
                    <th>Overdue tasks</th>
                  </tr>
                </thead>
                <tbody>
                  {r.team.map((u) => (
                    <tr key={u.id}>
                      <td className="font-medium">{u.name}</td>
                      <td>
                        <Link className="link" href={`/crm/leads?owner=${u.id}&open=1`}>
                          {u.open}
                        </Link>
                      </td>
                      <td>{u.admitted}</td>
                      <td>{pct(u.admitted, u.total)}</td>
                      <td>{u.calls}</td>
                      <td>{u.connected}</td>
                      <td>{u.visits}</td>
                      <td className={u.overdue ? 'font-semibold text-rose-700' : ''}>{u.overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </>
  );
}
