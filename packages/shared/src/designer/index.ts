/**
 * AI school designer (DECISIONS 56-59): block catalogue, changeset format, templates and the mock planner.
 * See docs/designer.md. Other products add their blocks and templates by registering them here.
 */
import { registerBlocks } from './catalogue';
import { CORE_BLOCKS, OS_BLOCKS } from './os-blocks';
import { OS_TEMPLATES, registerTemplates } from './templates';

export * from './catalogue';
export * from './changeset';
export * from './jsonSchema';
export * from './os-blocks';
export * from './templates';
export * from './mock';

// The catalogue: OS blocks, then the core stub that the custom records stream replaces. CRM and ERP register theirs here.
registerBlocks(OS_BLOCKS);
registerBlocks(CORE_BLOCKS);
registerTemplates(OS_TEMPLATES);
