/**
 * Web shell (decision 35): product switcher, product gate / "not part of your plan", school branding and the
 * platform session. How to mount them in a product layout: docs/shell.md.
 */
export { ProductSwitcher } from './product-switcher';
export { ProductGate, NotInPlan } from './product-gate';
export { SchoolBrand } from './brand';
export { usePlatformSession, useShellLang, signOut, hasProduct, brandColor, shellApi, ShellApiError, authErrorText, type PlatformSession, type ProductKeyName } from './session';
