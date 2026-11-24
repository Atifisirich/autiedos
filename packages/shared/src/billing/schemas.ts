/**
 * zod schemas for billing inputs. Shapes mirror the planned `billing` / `core.subscriptions`
 * tables but do not depend on them; the DB layer maps rows onto these.
 */
import { z } from 'zod';
import { GST_STATE_CODES, GSTIN_REGEX, isValidStateCode } from './gst';
import { PRODUCT_KEYS } from './plans';
import { SUBSCRIPTION_STATUSES } from './subscription';

export const paiseSchema = z.number().int().nonnegative().safe();
export const productKeySchema = z.enum(PRODUCT_KEYS);
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

export const stateCodeSchema = z.string().refine(isValidStateCode, { message: `Unknown GST state code (valid: ${Object.keys(GST_STATE_CODES).join(', ')})` });
export const gstinSchema = z
  .string()
  .regex(GSTIN_REGEX, 'Invalid GSTIN format')
  .refine((g) => isValidStateCode(g.slice(0, 2)), 'GSTIN has an unknown state code');

export const planPricingSchema = z.discriminatedUnion('model', [
  z.object({ model: z.literal('per_student'), unitPricePaise: paiseSchema, minBillableStudents: z.number().int().nonnegative().optional() }),
  z.object({ model: z.literal('flat'), flatPricePaise: paiseSchema, includedSeats: z.number().int().nonnegative(), extraSeatPricePaise: paiseSchema.optional() }),
]);

export const planSchema = z.object({
  key: z.string().min(1),
  productKey: productKeySchema,
  name: z.string().min(1),
  interval: z.enum(['monthly', 'yearly']),
  pricing: planPricingSchema,
  trialDays: z.number().int().nonnegative().max(365),
  currency: z.literal('INR'),
});

export const invoiceLineInputSchema = z.object({
  description: z.string().min(1),
  sacCode: z.string().regex(/^\d{4,8}$/).optional(),
  quantity: z.number().int().positive(),
  unitPricePaise: paiseSchema,
  discountPaise: paiseSchema.optional(),
});

export const computeInvoiceInputSchema = z.object({
  supplierStateCode: stateCodeSchema,
  placeOfSupplyStateCode: stateCodeSchema,
  lines: z.array(invoiceLineInputSchema).min(1),
  rateBps: z.number().int().min(0).max(10000).optional(),
});

export const billingPolicySchema = z.object({
  pastDueGraceDays: z.number().int().nonnegative().max(90),
  readOnlyDays: z.number().int().nonnegative().max(365),
});

const dateOrNull = z.coerce.date().nullable();
export const subscriptionStateSchema = z.object({
  status: subscriptionStatusSchema,
  trialEndsAt: dateOrNull,
  currentPeriodEnd: dateOrNull,
  pastDueSince: dateOrNull,
  suspendedAt: dateOrNull,
  cancelledAt: dateOrNull,
  cancelAtPeriodEnd: z.boolean(),
  lastEventAt: dateOrNull,
});
