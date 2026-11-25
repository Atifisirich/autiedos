/**
 * AI school designer, server side (DECISIONS 56-59, docs/designer.md).
 */
export * from './actor';
export * from './service';
export { serverBlock, serverBlocks, registerServerBlocks, type ServerBlock, type ApplyCtx } from './blocks';
export { systemPrompt } from './planner';
