/**
 * zod -> JSON schema for constrained AI output (Gemini `responseJsonSchema`).
 *
 * Deliberately small: it emits only the keywords the Gemini adapter is documented to accept (type, properties,
 * required, items, enum, anyOf, nullable via type arrays, minimum/maximum, minItems/maxItems, maxLength, pattern,
 * description, additionalProperties: false). Refinements are not expressible and are enforced by zod afterwards (the
 * planner validates and regenerates). Unknown zod types fall back to {} (any), never to an error.
 */
import type { ZodTypeAny } from 'zod';

export type JsonSchema = Record<string, unknown>;

// zod v3 keeps its definition on `_def`; reading it is the documented way to introspect a schema.
type Def = { typeName: string; [k: string]: unknown };
const def = (s: ZodTypeAny): Def => (s as unknown as { _def: Def })._def;

function withNull(schema: JsonSchema): JsonSchema {
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] };
  if (Array.isArray(schema.enum)) return { ...schema, enum: [...(schema.enum as unknown[]), null] };
  return { anyOf: [schema, { type: 'null' }] };
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const d = def(schema);
  const out = convert(schema, d);
  const description = (schema as unknown as { description?: string }).description;
  return description ? { ...out, description } : out;
}

function convert(schema: ZodTypeAny, d: Def): JsonSchema {
  switch (d.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const c of (d.checks as { kind: string; value?: number; regex?: RegExp }[]) ?? []) {
        if (c.kind === 'max') out.maxLength = c.value;
        if (c.kind === 'min') out.minLength = c.value;
        if (c.kind === 'regex' && c.regex) out.pattern = c.regex.source;
      }
      return out;
    }
    case 'ZodNumber': {
      const checks = (d.checks as { kind: string; value?: number }[]) ?? [];
      const out: JsonSchema = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.kind === 'min') out.minimum = c.value;
        if (c.kind === 'max') out.maximum = c.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodLiteral': {
      const v = d.value;
      return { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string', enum: [v] };
    }
    case 'ZodEnum':
      return { type: 'string', enum: [...(d.values as string[])] };
    case 'ZodNativeEnum':
      return { enum: Object.values(d.values as Record<string, string>) };
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: zodToJsonSchema(d.type as ZodTypeAny) };
      if (d.minLength) out.minItems = (d.minLength as { value: number }).value;
      if (d.maxLength) out.maxItems = (d.maxLength as { value: number }).value;
      return out;
    }
    case 'ZodObject': {
      const shape = (d.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        if (!v.isOptional()) required.push(k);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodRecord':
      return { type: 'object' };
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = (Array.isArray(d.options) ? d.options : [...(d.options as Map<unknown, ZodTypeAny>).values()]) as ZodTypeAny[];
      return { anyOf: options.map(zodToJsonSchema) };
    }
    case 'ZodOptional':
      return zodToJsonSchema(d.innerType as ZodTypeAny);
    case 'ZodNullable':
      return withNull(zodToJsonSchema(d.innerType as ZodTypeAny));
    case 'ZodDefault':
      return zodToJsonSchema(d.innerType as ZodTypeAny);
    case 'ZodEffects':
      return zodToJsonSchema(d.schema as ZodTypeAny);
    case 'ZodLazy':
      return zodToJsonSchema((d.getter as () => ZodTypeAny)());
    case 'ZodPipeline':
      return zodToJsonSchema(d.in as ZodTypeAny);
    case 'ZodBranded':
    case 'ZodReadonly':
    case 'ZodCatch':
      return zodToJsonSchema((d.type ?? d.innerType) as ZodTypeAny);
    default:
      void schema;
      return {};
  }
}
