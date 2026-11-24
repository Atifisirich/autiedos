/** Shared types and errors of the compliance tooling (docs/adr/compliance-tooling.md). */

export const PERSON_TYPES = ['staff', 'student', 'guardian', 'lead'] as const;
export type PersonType = (typeof PERSON_TYPES)[number];

export const PRODUCT_KEYS = ['crm', 'os', 'erp'] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

export const CONSENT_CHANNELS = ['whatsapp', 'sms', 'email', 'push', 'voice'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export type ConsentPurpose = 'service' | 'promotional';
export type ConsentStatus = 'opted_in' | 'opted_out' | 'unknown';

/** What the service reports when a request is stopped on purpose (holds, grace period, token ...). */
export interface Blocker {
  code: string;
  [k: string]: unknown;
}

export type ComplianceErrorCode = 'unauthenticated' | 'forbidden' | 'invalid' | 'not_found' | 'refused' | 'integrity' | 'internal';

/** Thrown for anything the caller can act on. `status` is the HTTP status the route table answers with. */
export class ComplianceError extends Error {
  constructor(
    public readonly code: ComplianceErrorCode,
    message: string,
    public readonly blockers: Blocker[] = [],
  ) {
    super(message);
    this.name = 'ComplianceError';
  }
  get status(): number {
    switch (this.code) {
      case 'unauthenticated':
        return 401;
      case 'forbidden':
        return 403;
      case 'invalid':
        return 422;
      case 'not_found':
        return 404;
      case 'refused':
        return 409;
      default:
        return 500;
    }
  }
}

/** The shape of the dry-run / execution plans the SQL functions return. */
export interface PlanTable {
  schema: string;
  table: string;
  rows: number;
  key_column?: string;
  mode?: string;
  reason?: string | null;
}

export interface ErasurePlan {
  tables: PlanTable[];
  deleted: number;
  anonymised: number;
  retained: number;
  external_actions: { kind: string; [k: string]: unknown }[];
}

export interface DeletionPlan {
  tables: PlanTable[];
  retained: PlanTable[];
  total_rows: number;
  auth_user_ids: string[];
}
