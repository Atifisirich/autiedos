/**
 * AI school designer (DECISIONS 56-59): block catalogue, changeset format, templates and the mock planner.
 * See docs/designer.md. Other products add their blocks and templates by registering them here.
 */
import { registerBlocks } from './catalogue';
import { CORE_BLOCKS } from './core-blocks';
import { CRM_BLOCKS } from './crm-blocks';
import { ERP_BLOCKS } from './erp-blocks';
import { OS_BLOCKS } from './os-blocks';
import { CRM_ERP_TEMPLATES } from './product-templates';
import { OS_TEMPLATES, registerTemplates } from './templates';

export * from './catalogue';
export * from './changeset';
export * from './jsonSchema';
export * from './os-blocks';
export * from './core-blocks';
export * from './crm-blocks';
export * from './erp-blocks';
export * from './product-templates';
export * from './templates';
export * from './mock';

// The catalogue: OS, CRM and ERP blocks and the custom records engine (core.custom_object).
registerBlocks(OS_BLOCKS);
registerBlocks(CRM_BLOCKS);
registerBlocks(ERP_BLOCKS);
registerBlocks(CORE_BLOCKS);
registerTemplates(OS_TEMPLATES);
registerTemplates(CRM_ERP_TEMPLATES);
