/**
 * Approval chain resolution (PRD 5.6 General approvals): steps by role or "manager of
 * applicant", conditional steps, parallel or sequential, delegation during leave.
 */
export interface StepDef {
  seq: number;
  approverKind: 'role' | 'manager_of_applicant' | 'staff';
  approverRoleId?: string | null;
  approverStaffId?: string | null;
  condition?: { field: string; op: '>' | '>=' | '<' | '<=' | '=' | '!='; value: number | string } | null;
  timeLimitHours: number;
}

export interface ChainContext {
  applicantId: string;
  data: Record<string, unknown>;
  reportsTo: Record<string, string | null | undefined>;
  /** roleId -> staff ids holding it (in the applicant's branch) */
  roleHolders: Record<string, string[]>;
  /** staffId -> delegate staffId for today, if the approver is on leave */
  delegates: Record<string, string>;
}

export function conditionHolds(cond: StepDef['condition'], data: Record<string, unknown>): boolean {
  if (!cond) return true;
  const raw = data[cond.field];
  const a = typeof cond.value === 'number' ? Number(raw) : String(raw ?? '');
  const b = cond.value;
  switch (cond.op) {
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '=':
      return a === b;
    case '!=':
      return a !== b;
  }
}

export interface ResolvedStage {
  seq: number;
  approverIds: string[];
  timeLimitHours: number;
}

/**
 * Turns a flow's step definitions into ordered stages. Steps sharing a seq run in parallel
 * (all must approve). Steps whose condition fails are skipped. The applicant never approves
 * their own request; delegates replace approvers on leave. Stages with no approver are dropped.
 */
export function resolveChain(steps: StepDef[], ctx: ChainContext): ResolvedStage[] {
  const bySeq = new Map<number, StepDef[]>();
  for (const s of steps) {
    if (!conditionHolds(s.condition ?? null, ctx.data)) continue;
    bySeq.set(s.seq, [...(bySeq.get(s.seq) ?? []), s]);
  }
  const stages: ResolvedStage[] = [];
  for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
    const defs = bySeq.get(seq)!;
    const ids = new Set<string>();
    for (const d of defs) {
      let candidates: string[] = [];
      if (d.approverKind === 'staff' && d.approverStaffId) candidates = [d.approverStaffId];
      else if (d.approverKind === 'manager_of_applicant') {
        const m = ctx.reportsTo[ctx.applicantId];
        candidates = m ? [m] : [];
      } else if (d.approverKind === 'role' && d.approverRoleId) candidates = ctx.roleHolders[d.approverRoleId] ?? [];
      for (const c of candidates) {
        const who = ctx.delegates[c] ?? c;
        if (who !== ctx.applicantId) ids.add(who);
      }
    }
    if (ids.size) stages.push({ seq, approverIds: [...ids].sort(), timeLimitHours: Math.min(...defs.map((d) => d.timeLimitHours)) });
  }
  return stages;
}

export type ApprovalAction = 'approve' | 'reject' | 'return' | 'forward';

export interface RequestState {
  status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  stageIndex: number;
  /** approvals collected in the current stage */
  approvedBy: string[];
}

/**
 * Applies an approver action. A stage completes when every approver in it approved
 * (role steps are satisfied by any one holder: callers pass `anyOf` = true for those).
 */
export function applyApproval(
  state: RequestState,
  stages: ResolvedStage[],
  actorId: string,
  action: ApprovalAction,
  opts: { anyOf?: boolean; forwardTo?: string } = {},
): { state: RequestState; stages: ResolvedStage[]; error?: 'not_an_approver' | 'not_pending' } {
  if (state.status !== 'pending') return { state, stages, error: 'not_pending' };
  const stage = stages[state.stageIndex];
  if (!stage || !stage.approverIds.includes(actorId)) return { state, stages, error: 'not_an_approver' };
  if (action === 'reject') return { state: { ...state, status: 'rejected' }, stages };
  if (action === 'return') return { state: { ...state, status: 'returned' }, stages };
  if (action === 'forward') {
    if (!opts.forwardTo) return { state, stages, error: 'not_an_approver' };
    const next = stages.slice();
    next.splice(state.stageIndex + 1, 0, { seq: stage.seq + 0.5, approverIds: [opts.forwardTo], timeLimitHours: stage.timeLimitHours });
    // forwarding counts as this approver's approval of their stage
    return applyApproval(state, next, actorId, 'approve', { anyOf: true });
  }
  const approvedBy = [...new Set([...state.approvedBy, actorId])];
  const stageDone = opts.anyOf ? true : stage.approverIds.every((id) => approvedBy.includes(id));
  if (!stageDone) return { state: { ...state, approvedBy }, stages };
  const nextIndex = state.stageIndex + 1;
  if (nextIndex >= stages.length) return { state: { status: 'approved', stageIndex: nextIndex, approvedBy: [] }, stages };
  return { state: { status: 'pending', stageIndex: nextIndex, approvedBy: [] }, stages };
}
