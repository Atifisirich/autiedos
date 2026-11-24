/**
 * AutoEd platform admin console: server side. Entry point for the Next.js route (`@autoed/server/platform-admin`)
 * and for tests. See docs/adr/admin-console.md.
 */
export { dispatchAdmin, listAdminRoutes, type AdminRequest, type AdminResponse } from './routes';
export { createAdminDb, ADMIN_ROLE, type AdminDb, type Tx } from './db';
export { createAdminAuth, type AdminAuth, type AdminSession } from './auth';
export { createMemoryProvisioner, createSupabaseProvisioner, createDevProvisioner, type AuthProvisioner } from './provisioner';
export { configFromEnv, type AdminConfig, type AdminDeps } from './deps';
export { AdminError } from './errors';
export { computeHealth, type HealthLevel, type HealthReason } from './health';
// For product servers: the banner while "viewing as", and the client admins' own log of support access.
export { currentViewAs, clientSupportSessions, type ViewAsBanner, type ClientVisibleSession } from './support';
