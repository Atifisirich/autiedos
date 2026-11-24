// ERP rule libraries (ported from hbi83701-tech/autoederp src/lib/rules; golden tests in test/erp-*.test.ts).
// Imported as '@autoed/shared/erp'. Not re-exported from the package root: names such as `leaveBalance` and
// `rankSubstitutes` already exist in the OS rules.
export * from './fees';
export * from './grading';
export * from './payroll';
export * from './risk';
export * from './timetable';
export * from './calendar';
export * from './boards';
export * from './ai';
