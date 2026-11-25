/**
 * Server registry of designer blocks: block key -> read / write / remove. The shared catalogue
 * (@autoed/shared designer) says WHAT a block is; this says HOW it is applied. A catalogue block without a server
 * block cannot be published.
 *
 * Adding a block: implement ServerBlock in blocks/<product>/<area>.ts and call registerServerBlocks([...]) below
 * (or from your product's module at import time).
 */
import { approvalTypeServer } from './os/approvals';
import { checklistServer } from './os/checklists';
import { assignmentRuleServer, escalationRuleServer, recurringTaskServer, taskCategoryServer } from './os/tasks';
import { notificationRuleServer, reportScheduleServer } from './os/notifications';
import { attendanceRuleServer, customFieldServer, leaveTypeServer, moduleFlagServer, rolePermissionServer, roleServer } from './os/people';
import { dutyTypeServer, eventTemplateServer, planReviewServer } from './os/planning';
import { customObjectServer } from './core/custom-object';
import { CRM_SERVER_BLOCKS } from './crm';
import { ERP_SERVER_BLOCKS } from './erp';
import type { ServerBlock } from './types';

export * from './types';

const registry = new Map<string, ServerBlock>();

export function registerServerBlocks(blocks: ServerBlock[]): void {
  for (const b of blocks) registry.set(b.key, b);
}

export function serverBlock(key: string): ServerBlock | undefined {
  return registry.get(key);
}

export function serverBlocks(): ServerBlock[] {
  return [...registry.values()];
}

registerServerBlocks([
  approvalTypeServer,
  checklistServer,
  taskCategoryServer,
  recurringTaskServer,
  escalationRuleServer,
  assignmentRuleServer,
  notificationRuleServer,
  leaveTypeServer,
  attendanceRuleServer,
  moduleFlagServer,
  roleServer,
  rolePermissionServer,
  customFieldServer,
  reportScheduleServer,
  eventTemplateServer,
  dutyTypeServer,
  planReviewServer,
]);
// CRM blocks run as crm_server, ERP blocks as erp_server (x.tx(product)); the custom records engine in the designer's own transaction.
registerServerBlocks(CRM_SERVER_BLOCKS);
registerServerBlocks(ERP_SERVER_BLOCKS);
registerServerBlocks([customObjectServer]);
