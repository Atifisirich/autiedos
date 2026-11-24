/**
 * AI helpers of the ERP go through an interface only (decision 40: Gemini is the only provider, no Anthropic).
 * `erpAi` is the hook the screens call. Until the platform AI adapter is wired to the ERP server it answers "no", and every screen
 * falls back to its rule-based version (report-card remarks, insights). Prompts must never contain names or other personal data.
 */
import { noAi, type ErpAiHook } from '@autoed/shared/erp';

export const erpAi: ErpAiHook = noAi;
export const aiEnabled = () => false;
