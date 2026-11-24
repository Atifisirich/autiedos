/**
 * Dependencies of the admin console, injected so tests and the web route can swap them:
 *  - db: connection as platform_admin_server;
 *  - auth: how an admin signs in and how a request is authenticated;
 *  - provisioner: creates / removes the auth user behind an invited person (Supabase Auth owns credentials);
 *  - config: AutoEd's own billing identity (supplier state and GSTIN), never hard-coded;
 *  - now: clock.
 */
import { createAdminDb, type AdminDb } from './db';
import { createAdminAuth, type AdminAuth } from './auth';
import { createProvisionerFromEnv, type AuthProvisioner } from './provisioner';

export interface AdminConfig {
  /** GST state code of the invoicing entity (two digits). Required to create an invoice. */
  supplierStateCode: string | null;
  supplierGstin: string | null;
  /** Default view-as length in minutes. */
  defaultViewAsMinutes: number;
  /** Default free trial for a new subscription (decision pending: plan trial lengths are not set). */
  defaultTrialDays: number;
}

export interface AdminDeps {
  db: AdminDb;
  auth: AdminAuth;
  provisioner: AuthProvisioner;
  config: AdminConfig;
  now: () => Date;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): AdminConfig {
  return {
    supplierStateCode: env.AUTOED_SUPPLIER_STATE_CODE?.trim() || null,
    supplierGstin: env.AUTOED_SUPPLIER_GSTIN?.trim() || null,
    defaultViewAsMinutes: Number(env.ADMIN_VIEW_AS_MINUTES ?? 60),
    defaultTrialDays: Number(env.ADMIN_DEFAULT_TRIAL_DAYS ?? 14),
  };
}

const shared: Partial<AdminDeps> = {};

/** Environment-based defaults, each built on first use (nothing connects at import time). */
const defaults = {
  db: () => (shared.db ??= createAdminDb()),
  auth: () => (shared.auth ??= createAdminAuth()),
  provisioner: () => (shared.provisioner ??= createProvisionerFromEnv()),
  config: () => (shared.config ??= configFromEnv()),
};

/** Fills in what the caller did not provide (a test passes everything and touches no environment). */
export function resolveDeps(over: Partial<AdminDeps> = {}): AdminDeps {
  return {
    db: over.db ?? defaults.db(),
    auth: over.auth ?? defaults.auth(),
    provisioner: over.provisioner ?? defaults.provisioner(),
    config: over.config ?? defaults.config(),
    now: over.now ?? (() => new Date()),
  };
}
