/**
 * Assignment rules engine (PRD 4.3).
 * Explicit rules per role pair win; the most permissive explicit rule applies when a person
 * holds several roles. Without an explicit rule: anyone below in the reporting tree -> assign,
 * peers and upward -> request.
 */
export type AssignMode = 'assign' | 'request' | 'none';

export interface AssignRule {
  fromRoleId: string;
  toRoleId: string;
  rule: AssignMode;
}

export interface OrgGraph {
  /** staffId -> primary manager staffId */
  reportsTo: Record<string, string | null | undefined>;
  /** secondary reporting lines: staffId -> manager staffIds */
  secondary?: Record<string, string[]>;
  /** staffId -> role ids */
  roles: Record<string, string[]>;
}

export interface AssignDecision {
  mode: AssignMode;
  reason: 'self' | 'explicit_rule' | 'below_in_tree' | 'peer_or_upward';
}

const RANK: Record<AssignMode, number> = { none: 0, request: 1, assign: 2 };

/** Is `staffId` below `managerId` in the reporting tree (primary or secondary lines)? */
export function isBelow(staffId: string, managerId: string, graph: OrgGraph): boolean {
  const seen = new Set<string>();
  const stack = [staffId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const managers = [graph.reportsTo[cur], ...(graph.secondary?.[cur] ?? [])].filter((m): m is string => !!m);
    for (const m of managers) {
      if (m === managerId) return true;
      stack.push(m);
    }
  }
  return false;
}

export function canAssign(assignerId: string, assigneeId: string, graph: OrgGraph, rules: AssignRule[]): AssignDecision {
  if (assignerId === assigneeId) return { mode: 'assign', reason: 'self' };
  const fromRoles = graph.roles[assignerId] ?? [];
  const toRoles = graph.roles[assigneeId] ?? [];
  let best: AssignMode | null = null;
  for (const r of rules) {
    if (fromRoles.includes(r.fromRoleId) && toRoles.includes(r.toRoleId)) {
      if (best === null || RANK[r.rule] > RANK[best]) best = r.rule;
    }
  }
  if (best !== null) return { mode: best, reason: 'explicit_rule' };
  if (isBelow(assigneeId, assignerId, graph)) return { mode: 'assign', reason: 'below_in_tree' };
  return { mode: 'request', reason: 'peer_or_upward' };
}
