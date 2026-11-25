/**
 * Custom records engine (docs/custom-records.md): typed objects defined by the school (or the AI designer), their
 * records, history, workflow, CSV export and reminders, over core.custom_objects / custom_records / custom_record_events.
 */
export * from './types';
export * from './db';
export * from './service';
export { runRecordReminders } from './reminders';
export { dispatchRecords, type RecordsRequest, type RecordsResponse, type RecordsDeps, type Principal } from './routes';
export * from './designer-adapter';
