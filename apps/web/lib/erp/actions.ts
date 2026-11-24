'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { TOKEN_COOKIE } from './db';

export async function signOut() {
  (await cookies()).delete(TOKEN_COOKIE);
  redirect('/erp/login');
}

/** Branch and year are filters in the header, not a separate login step. */
export async function setFilter(fd: FormData) {
  const store = await cookies();
  for (const k of ['branch', 'year']) {
    const v = fd.get(k);
    if (typeof v === 'string') { if (v) store.set(k, v, { path: '/', maxAge: 60 * 60 * 24 * 365 }); else store.delete(k); }
  }
  revalidatePath('/erp', 'layout');
}
