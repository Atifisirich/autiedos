/** Input schemas of the admin console routes (billing shapes come from @autoed/shared). */
import { z } from 'zod';
import { gstinSchema, paiseSchema, productKeySchema, stateCodeSchema } from '@autoed/shared';

export const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Why a sensitive change is made; stored in audit.log. */
export const reason = z.string().trim().min(5).max(500);

export const CLIENT_KINDS = ['school', 'coaching_centre', 'college', 'other'] as const;

const branchInput = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(1).max(20),
  city: z.string().trim().max(80).nullish(),
  state_code: stateCodeSchema.nullish(),
  time_zone: z.string().trim().max(60).nullish(),
});

export const subscriptionCreate = z.object({
  product_key: productKeySchema,
  plan_key: z.string().min(1).nullish(),
  status: z.enum(['trial', 'active']).default('trial'),
  trial_days: z.number().int().min(1).max(365).optional(),
  seats: z.number().int().positive().nullish(),
  starts_on: isoDate.optional(),
  ends_on: isoDate.nullish(),
});

export const billingAccountInput = z.object({
  legal_name: z.string().trim().min(2).max(200),
  gstin: gstinSchema.nullish(),
  state_code: stateCodeSchema,
  billing_email: z.string().email().nullish(),
  address: z.string().trim().max(500).nullish(),
});

export const clientCreate = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  kind: z.enum(CLIENT_KINDS).default('school'),
  legal_name: z.string().trim().max(200).nullish(),
  time_zone: z.string().trim().max(60).default('Asia/Kolkata'),
  default_locale: z.enum(['en', 'hi', 'te']).default('en'),
  branch: branchInput,
  subscriptions: z.array(subscriptionCreate).min(1).max(3),
  admin: z.object({ email: z.string().email(), display_name: z.string().trim().min(2).max(120) }),
  billing: billingAccountInput.optional(),
});

export const clientPatch = z
  .object({
    name: z.string().trim().min(2).max(120),
    legal_name: z.string().trim().max(200).nullable(),
    kind: z.enum(CLIENT_KINDS),
    time_zone: z.string().trim().max(60),
    default_locale: z.enum(['en', 'hi', 'te']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' });

export const reasonOnly = z.object({ reason });

export const branchSave = branchInput.extend({ active: z.boolean().default(true) });
export const branchProduct = z.object({ branch_id: uuid, product_key: productKeySchema, enabled: z.boolean() });

export const subscriptionPatch = z
  .object({
    plan_key: z.string().min(1).nullable(),
    seats: z.number().int().positive().nullable(),
    ends_on: isoDate.nullable(),
    notes: z.string().max(500).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' });

export const TRANSITIONS = ['activate', 'mark_past_due', 'suspend', 'cancel', 'tick'] as const;
export const subscriptionTransition = z.object({ event: z.enum(TRANSITIONS), reason, period_end: isoDate.optional() });
export const subscriptionRestart = z.object({ reason, status: z.enum(['trial', 'active']).default('trial'), trial_days: z.number().int().min(1).max(365).optional(), plan_key: z.string().min(1).nullish() });

export const userInvite = z.object({
  email: z.string().email(),
  display_name: z.string().trim().min(2).max(120),
  kind: z.enum(['staff', 'guardian', 'parent', 'student']).default('staff'),
  home_branch_id: uuid.nullish(),
  access: z.array(z.object({ product_key: productKeySchema, role_key: z.string().regex(/^[a-z][a-z0-9_]*$/) })).default([]),
});
export const userLock = z.object({ locked: z.boolean(), reason, minutes: z.number().int().min(1).max(5256000).optional() });
export const userForceReset = z.object({ required: z.boolean(), reason });
export const userStatus = z.object({ status: z.enum(['invited', 'active', 'disabled']), reason });
export const userAccess = z.object({ product_key: productKeySchema, role_key: z.string().regex(/^[a-z][a-z0-9_]*$/) });

export const viewAsStart = z.object({ reason: z.string().trim().min(10).max(500), minutes: z.number().int().min(1).max(240).optional(), read_only: z.boolean().default(true) });

export const planUpsert = z.object({
  product_key: productKeySchema,
  name: z.string().trim().min(2).max(120),
  billing_interval: z.enum(['month', 'year']),
  price_paise: paiseSchema,
  sac_code: z.string().regex(/^\d{4,8}$/).nullish(),
  gst_rate: z.number().min(0).max(28).default(18),
  razorpay_plan_id: z.string().min(1).nullish(),
  active: z.boolean().default(true),
});

export const invoiceCreate = z.object({
  invoice_date: isoDate.optional(),
  rate_bps: z.number().int().min(0).max(10000).optional(),
  place_of_supply: stateCodeSchema.optional(),
  lines: z
    .array(
      z.object({
        product_key: productKeySchema.nullish(),
        description: z.string().trim().min(2).max(300),
        sac_code: z.string().regex(/^\d{4,8}$/).optional(),
        quantity: z.number().int().positive(),
        unit_price_paise: paiseSchema,
        discount_paise: paiseSchema.optional(),
      }),
    )
    .min(1)
    .max(30),
});

export const devLogin = z.object({ email: z.string().email() });
export const providerSession = z.object({ accessToken: z.string().min(10) });

/** Query-string filters of lists and the audit viewer (all optional strings). */
export const clientsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  health: z.enum(['ok', 'attention', 'critical']).optional(),
  product: productKeySchema.optional(),
});

export const auditQuery = z.object({
  source: z.enum(['log', 'config']).default('log'),
  org_id: uuid.optional(),
  actor: uuid.optional(),
  action: z.string().trim().max(80).optional(),
  table: z.string().trim().max(80).optional(),
  row_id: uuid.optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  before_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
