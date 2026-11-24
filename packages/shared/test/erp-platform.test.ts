import { describe, it, expect } from 'vitest';
import { isWorking, countWorking, holidaysFrom, noAi, draftRemark } from '../src/erp';

// What changed in the port: platform column shapes and the AI hook.
describe('erp rules on the platform data shapes', () => {
  it('working days accept the integer[] of core.branches and the old text list', () => {
    expect(isWorking('2026-11-14', [1, 2, 3, 4, 5, 6], [])).toBe(true); // Saturday
    expect(isWorking('2026-11-14', [1, 2, 3, 4, 5], [])).toBe(false);
    expect(isWorking('2026-11-14', '1,2,3,4,5', [])).toBe(false);
    expect(isWorking('2026-11-14', null, [])).toBe(true); // default Mon-Sat
    expect(countWorking('2026-11-09', '2026-11-15', [1, 2, 3, 4, 5, 6], [])).toBe(6);
  });

  it('holidays come from core.calendar_events rows of layer holiday', () => {
    const hol = holidaysFrom([
      { layer: 'holiday', starts_on: '2026-11-16', ends_on: null },
      { layer: 'exam', starts_on: '2026-11-17', ends_on: null },
      { layer: 'holiday', starts_on: '2026-11-18', ends_on: '2026-11-19' },
    ]);
    expect(hol).toHaveLength(2);
    expect(isWorking('2026-11-16', [1, 2, 3, 4, 5, 6], hol)).toBe(false);
    expect(isWorking('2026-11-17', [1, 2, 3, 4, 5, 6], hol)).toBe(true);
    expect(isWorking('2026-11-19', [1, 2, 3, 4, 5, 6], hol)).toBe(false);
  });

  it('the AI hook is an interface: with no provider every feature falls back to its rule-based text', async () => {
    expect(await noAi.text('system', 'user')).toBeNull();
    expect(await noAi.json('system', 'user')).toBeNull();
    expect(draftRemark('Asha Rao', 90, 98, 'Maths')).toBe('Asha has had an excellent term and works with real independence. Maths is a clear strength.');
  });
});
