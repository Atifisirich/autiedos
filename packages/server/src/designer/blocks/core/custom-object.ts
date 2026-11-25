/**
 * core.custom_object: a new register or form of the custom records engine (docs/custom-records.md "Designer adapter").
 *
 * Everything goes through the engine's designer adapter (customObjectBlock: validate / apply / inverse) and its
 * services, inside the designer's own transaction: the adapter's database calls run in a savepoint of that
 * transaction (same login, same claims), so the engine's RLS (management only, read-write support session), its
 * validation trigger and the audit trigger apply, a dry run is rolled back with everything else, and publishing is
 * one unit. Only definitions are read or written, never records (decision 56).
 */
import { recordObjectSchema } from '@autoed/shared';
import { ValidationError } from '../../../db';
import { customObjectBlock, type CustomObjectBlockContext } from '../../../custom-records/designer-adapter';
import type { Queryable, RecordsDb } from '../../../custom-records/db';
import { getObject, listObjects, toInput } from '../../../custom-records/service';
import { RecordsError } from '../../../custom-records/types';
import type { ApplyCtx, ServerBlock, Settings } from '../types';

let sp = 0;
/** The engine's RecordsDb over the designer's transaction: each engine call is a savepoint of it. */
function recordsDb(x: ApplyCtx): RecordsDb {
  return {
    async run(_role, _userId, fn) {
      const name = `records_${++sp}`;
      await x.c.query(`savepoint ${name}`);
      try {
        const out = await fn(x.c as unknown as Queryable);
        await x.c.query(`release savepoint ${name}`);
        return out;
      } catch (e) {
        await x.c.query(`rollback to savepoint ${name}`);
        throw e;
      }
    },
  };
}

const ctxOf = (x: ApplyCtx): CustomObjectBlockContext => ({ db: recordsDb(x), userId: x.actor.userId, products: x.actor.products });

/** An engine error as the designer's 422 / 403 (the message names the rule, never a record). */
function asDesignerError(e: unknown): never {
  if (e instanceof RecordsError) {
    if (e.code === 'forbidden') throw Object.assign(new Error(e.message), { status: 403 });
    throw new ValidationError(e.message === 'invalid_definition' ? 'record_definition_invalid' : e.message, { issues: e.details });
  }
  throw e;
}

/** The definition as the designer compares it (normalised by the shared schema; "archived" is the item's absence). */
function normalise(def: Settings): Settings {
  const p = recordObjectSchema.safeParse(def);
  const out = { ...(p.success ? p.data : def) } as Settings;
  delete out.archived;
  return JSON.parse(JSON.stringify(out)) as Settings;
}

export const customObjectServer: ServerBlock = {
  key: 'core.custom_object',
  async read(x, key) {
    try {
      const o = await getObject(ctxOf(x), key);
      return o.archived ? null : normalise(toInput(o) as Settings);
    } catch (e) {
      if (e instanceof RecordsError && e.code === 'not_found') return null;
      return asDesignerError(e);
    }
  },
  async list(x) {
    try {
      return (await listObjects(ctxOf(x))).map((o) => ({ key: o.key, name: o.label_plural }));
    } catch {
      return [];
    }
  },
  /** The engine's own checks with the school's configuration: management rights, existing object, roles exist. */
  async check(x, settings) {
    const v = await customObjectBlock.validate(settings, ctxOf(x));
    return v.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`);
  },
  async write(x, _key, settings) {
    try {
      await customObjectBlock.apply({ ...settings, archived: false }, ctxOf(x));
    } catch (e) {
      asDesignerError(e);
    }
  },
  async remove(x, key) {
    try {
      // the adapter's undo of a created object: deleted, or archived when entries were added since (no data is lost)
      await customObjectBlock.inverse({ type: 'custom_object', mode: 'create', objectId: '', key, version: 0, before: null }, ctxOf(x));
    } catch (e) {
      if (e instanceof RecordsError && e.code === 'not_found') return;
      asDesignerError(e);
    }
  },
};
