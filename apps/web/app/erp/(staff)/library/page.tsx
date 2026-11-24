import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { fullNameOf } from '@/lib/erp/q';
import { lookup, options } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field, Stat } from '@/components/erp/ui';
import { fdate, go, str, today } from '@/lib/erp/fmt';
import { addDays } from '@/lib/erp/calendar';
import { daysBetween } from '@autoed/shared/erp';

export const metadata = { title: 'Library' };
async function nextAccession(ctx: Awaited<ReturnType<typeof requireCap>>) {
  const r = await core(ctx.sb).rpc('next_number', { p_key: 'accession', p_branch: ctx.branchId ?? null, p_year: null });
  return r.error ? `ACC${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 90 + 10)}` : (r.data as string);
}
async function issue(fd: FormData) {
  'use server';
  const ctx = await requireCap('library', 'write');
  const acc = str(fd, 'accession')!;
  const { data } = await erp(ctx.sb).from('book_copies').select('id, book_id, status').or(`accession_no.eq.${acc},barcode.eq.${acc}`).is('deleted_at', null).maybeSingle();
  const copy = data as { id: string; book_id: string; status: string } | null;
  if (!copy) go('/erp/library', 'No copy has that accession number or barcode.', 'err');
  if (copy!.status !== 'available') go('/erp/library', `That copy is ${copy!.status}.`, 'err');
  const who = str(fd, 'student_id');
  if (!who) go('/erp/library', 'Choose the borrower.', 'err');
  const { error } = await erp(ctx.sb).from('loans').insert({ copy_id: copy!.id, book_id: copy!.book_id, student_id: who, due_on: addDays(today(), Number(str(fd, 'days') ?? 14)) });
  if (!error) await erp(ctx.sb).from('book_copies').update({ status: 'issued' }).eq('id', copy!.id);
  go('/erp/library', error ? error.message : 'Issued.', error ? 'err' : 'ok');
}
/** Return by scanning; overdue fines go through the fee engine as a demand (LIB-02). */
async function giveBack(fd: FormData) {
  'use server';
  const ctx = await requireCap('library', 'write');
  const id = str(fd, 'loan')!;
  const { data } = await erp(ctx.sb).from('loans').select('id, copy_id, due_on, student_id').eq('id', id).single();
  const l = data as { id: string; copy_id: string; due_on: string; student_id: string | null };
  const late = Math.max(0, daysBetween(l.due_on, today()));
  const rate = Number(((ctx.org.settings ?? {}) as { library_fine_per_day?: number }).library_fine_per_day ?? 2);
  const fine = late * rate;
  await erp(ctx.sb).from('loans').update({ returned_on: today(), fine }).eq('id', id);
  await erp(ctx.sb).from('book_copies').update({ status: 'available' }).eq('id', l.copy_id);
  if (fine > 0 && l.student_id && ctx.can('fees', 'write')) {
    const { data: fh } = await erp(ctx.sb).from('fee_heads').select('id').eq('type', 'fine').is('deleted_at', null).limit(1);
    const { data: st } = await core(ctx.sb).from('students').select('branch_id').eq('id', l.student_id).single();
    if (fh?.length) await erp(ctx.sb).from('fee_demands').insert({ student_id: l.student_id, branch_id: (st as { branch_id: string } | null)?.branch_id, academic_year_id: ctx.year?.id, head_id: (fh[0] as { id: string }).id, label: `Library fine (${late} days late)`, amount: fine, due_date: today() });
  }
  go('/erp/library', fine ? `Returned ${late} days late. Fine of Rs ${fine} recorded.` : 'Returned.');
}
async function renew(fd: FormData) {
  'use server';
  const ctx = await requireCap('library', 'write');
  const { data } = await erp(ctx.sb).from('loans').select('due_on, renewed').eq('id', str(fd, 'loan')!).single();
  const l = data as { due_on: string; renewed: number };
  await erp(ctx.sb).from('loans').update({ due_on: addDays(l.due_on, 14), renewed: (l.renewed ?? 0) + 1 }).eq('id', str(fd, 'loan')!);
  go('/erp/library', 'Renewed for 14 days.');
}
async function addBook(fd: FormData) {
  'use server';
  const ctx = await requireCap('library', 'write');
  const { data: b, error } = await erp(ctx.sb).from('books').insert({ title: str(fd, 'title'), author: str(fd, 'author'), isbn: str(fd, 'isbn'), category: str(fd, 'category'), location: str(fd, 'location') }).select('id').single();
  if (error) go('/erp/library', error.message, 'err');
  const n = Number(str(fd, 'copies') ?? 1);
  const rows = [];
  for (let i = 0; i < n; i++) { const acc = await nextAccession(ctx); rows.push({ book_id: (b as { id: string }).id, accession_no: acc, barcode: acc }); }
  const { error: ce } = await erp(ctx.sb).from('book_copies').insert(rows);
  go('/erp/library', ce ? ce.message : `Added with ${n} cop${n === 1 ? 'y' : 'ies'}: ${rows.map((r) => r.accession_no).join(', ')}.`, ce ? 'err' : 'ok');
}

type L = { id: string; issued_on: string; due_on: string; renewed: number; book: { title: string } | null; copy: { accession_no: string } | null; student_id: string | null };
export default async function Library({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('library');
  const d = today();
  const term = (sp.q ?? '').replace(/[%,()]/g, ' ').trim();
  const [{ data: loans }, studs, { data: books }, { count: copies }, { data: resv }] = await Promise.all([
    erp(ctx.sb).from('loans').select('id, issued_on, due_on, renewed, student_id, book:books(title), copy:book_copies(accession_no)').is('returned_on', null).is('deleted_at', null).order('due_on').limit(300),
    options(ctx, 'students'),
    term ? erp(ctx.sb).from('books').select('id, title, author, isbn, location, copies:book_copies(accession_no, status)').or(`title.ilike.%${term}%,author.ilike.%${term}%,isbn.ilike.%${term}%`).is('deleted_at', null).limit(20) : Promise.resolve({ data: null }),
    erp(ctx.sb).from('book_copies').select('id', { count: 'exact', head: true }).is('deleted_at', null), erp(ctx.sb).from('book_reservations').select('id').eq('status', 'waiting').is('deleted_at', null),
  ]);
  const Ls = (loans ?? []) as unknown as L[];
  const st = await lookup(ctx, 'students', Ls.map((l) => l.student_id));
  const can = ctx.can('library', 'write');
  return (
    <Page title="Library" sub="Scan-based issue and return. Overdue fines are added to the student's fees." actions={<><Link className="btn-ghost" href="/erp/x/books">Catalogue</Link><Link className="btn-ghost" href="/erp/x/reading_logs">Reading programme</Link></>}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Copies" value={copies ?? 0} /><Stat label="Out on loan" value={Ls.length} /><Stat label="Overdue" value={Ls.filter((l) => l.due_on < d).length} tone="warn" /><Stat label="Reservations waiting" value={(resv ?? []).length} /></div>
      <div className="grid gap-4 lg:grid-cols-3">
        {can && <div className="space-y-4"><Card title="Issue a book"><form action={issue} className="space-y-3 p-4"><Field label="Accession number or barcode"><input name="accession" required autoFocus className="input !py-3 text-base" /></Field><Field label="Borrower"><select name="student_id" className="input" required><option value="">Choose student</option>{studs.map((s) => <option key={s.value} value={s.value}>{s.label} · {String(s.row.admission_no ?? '')}</option>)}</select></Field><Field label="Days"><input name="days" type="number" defaultValue={14} className="input" /></Field><button className="btn w-full">Issue</button></form></Card>
          <Card title="Add a title"><form action={addBook} className="space-y-2 p-4"><input name="title" required placeholder="Title" className="input" aria-label="Title" /><input name="author" placeholder="Author" className="input" aria-label="Author" /><div className="grid grid-cols-2 gap-2"><input name="isbn" placeholder="ISBN" className="input" aria-label="ISBN" /><input name="copies" type="number" min={1} defaultValue={1} className="input" aria-label="Copies" /></div><div className="grid grid-cols-2 gap-2"><input name="category" placeholder="Category" className="input" aria-label="Category" /><input name="location" placeholder="Shelf" className="input" aria-label="Shelf" /></div><button className="btn-ghost w-full">Add with accession numbers</button></form></Card></div>}
        <div className={`space-y-4 ${can ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
          <Card title="Find a book"><form className="flex gap-2 p-4"><input name="q" defaultValue={sp.q ?? ''} placeholder="Title, author or ISBN" className="input" aria-label="Search catalogue" /><button className="btn-ghost">Search</button></form>
            {books && (books.length === 0 ? <Empty title="No match in the catalogue" /> : <ul className="divide-y divide-line border-t border-line text-sm">{(books as unknown as { id: string; title: string; author: string | null; location: string | null; copies: { accession_no: string; status: string }[] }[]).map((b) => <li key={b.id} className="px-4 py-2"><span className="font-medium">{b.title}</span> <span className="text-muted">{b.author} · {b.location}</span><div className="mt-1 flex flex-wrap gap-1">{b.copies.map((c) => <Badge key={c.accession_no} tone={c.status === 'available' ? 'green' : 'grey'}>{c.accession_no} {c.status}</Badge>)}</div></li>)}</ul>)}</Card>
          <Card title="On loan">{Ls.length === 0 ? <Empty title="Nothing is out" /> : <table className="tbl"><thead><tr><th>Book</th><th>Borrower</th><th>Due</th><th></th></tr></thead><tbody>{Ls.map((l) => <tr key={l.id}><td>{l.book?.title}<div className="text-xs text-muted">{l.copy?.accession_no}</div></td><td>{fullNameOf(st.get(l.student_id) as never) || ''}</td><td className={l.due_on < d ? 'text-red-600' : ''}>{fdate(l.due_on)}{l.due_on < d ? ` · ${daysBetween(l.due_on, d)} days late` : ''}</td><td className="whitespace-nowrap text-right">{can && <><form action={renew} className="inline"><input type="hidden" name="loan" value={l.id} /><button className="btn-ghost btn-sm">Renew</button></form> <form action={giveBack} className="inline"><input type="hidden" name="loan" value={l.id} /><button className="btn btn-sm">Return</button></form></>}</td></tr>)}</tbody></table>}</Card>
        </div>
      </div>
    </Page>
  );
}
