import Link from 'next/link';
import { Suspense } from 'react';
import { getCtx, ROLE_LABEL } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { navFor, PRODUCT } from '@/lib/erp/nav';
import { CommandPalette, Flash, MobileNav, NavLink, AutoSubmitSelect } from '@/components/erp/client';
import { setFilter, signOut } from '@/lib/erp/actions';
import '@/components/erp/erp.css';

// Every ERP screen is per-user and reads through the Data API as that user; never prerender.
export const dynamic = 'force-dynamic';

export default async function ErpStaffLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  const groups = navFor(ctx);
  const [unread, mine] = await Promise.all([
    core(ctx.sb).from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', ctx.user.id).is('read_at', null).is('deleted_at', null),
    erp(ctx.sb).rpc('my_approvals'),
  ]);
  const pending = ((mine.data as unknown[]) ?? []).length;
  const unreadN = unread.count ?? 0;
  const pages = groups.flatMap((g) => g.items.map((i) => ({ label: i.label, sub: g.title, href: i.href })));
  return (
    <div className="erp lg:pl-60">
      <MobileNav>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-xs font-bold text-white">E</div>
          <div><div className="text-sm font-semibold leading-tight">{PRODUCT.name}</div><div className="max-w-[150px] truncate text-xs text-muted">{ctx.org.name}</div></div>
        </div>
        <nav className="space-y-4 p-3" aria-label="Main">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.title}</div>
              {g.items.map((i) => (
                <NavLink key={i.href} href={i.href}>
                  {i.label}
                  {i.href === '/erp/approvals' && pending > 0 ? <span className="ml-2 rounded-full bg-amber-100 px-1.5 text-xs text-amber-800">{pending}</span> : null}
                  {i.href === '/erp/inbox' && unreadN > 0 ? <span className="ml-2 rounded-full bg-brand-soft px-1.5 text-xs text-brand-dark">{unreadN}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </MobileNav>
      <header className="no-print sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-white/95 px-4 py-2 backdrop-blur">
        <div className="lg:hidden" />
        <Suspense><CommandPalette pages={pages} /></Suspense>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <form action={setFilter} className="hidden items-center gap-2 sm:flex">
            {!ctx.orgUser.home_branch_id && ctx.branches.length > 1 && (
              <AutoSubmitSelect name="branch" label="Branch filter" value={ctx.branchId ?? ''} className="input !w-auto !py-1.5" options={[{ value: '', label: 'All branches' }, ...ctx.branches.map((b) => ({ value: b.id, label: b.name }))]} />
            )}
            {ctx.years.length > 1 && <AutoSubmitSelect name="year" label="Academic year filter" value={ctx.year?.id ?? ''} className="input !w-auto !py-1.5" options={ctx.years.map((y) => ({ value: y.id, label: y.name }))} />}
          </form>
          <Link href="/erp/inbox" className="btn-ghost btn-sm" aria-label="Notifications">Alerts{unreadN > 0 ? ` (${unreadN})` : ''}</Link>
          <Link href="/erp/account" className="hidden text-right sm:block">
            <div className="text-xs font-medium leading-tight">{ctx.name}</div>
            <div className="text-[11px] leading-tight text-muted">{ROLE_LABEL[ctx.role] ?? ctx.role}</div>
          </Link>
          <form action={signOut} className="hidden sm:block"><button className="btn-ghost btn-sm">Sign out</button></form>
        </div>
      </header>
      <main>{children}</main>
      <Suspense><Flash /></Suspense>
    </div>
  );
}
