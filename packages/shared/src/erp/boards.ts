/** Board packs as data (ERP CF-07): grade scales and assessment scheme defaults a school installs and then edits. Pure data; the installer that wrote them to the database is a screen action (docs/erp-port.md). */
export const BOARDS = ['CBSE', 'Cambridge', 'ICSE', 'IB', 'State', 'Pre-school', 'Mixed'] as const;

export const SCALES: Record<string, { min: number; grade: string; point?: number; descriptor?: string }[]> = {
  CBSE: [{ min: 91, grade: 'A1', point: 10 }, { min: 81, grade: 'A2', point: 9 }, { min: 71, grade: 'B1', point: 8 }, { min: 61, grade: 'B2', point: 7 }, { min: 51, grade: 'C1', point: 6 }, { min: 41, grade: 'C2', point: 5 }, { min: 33, grade: 'D', point: 4 }, { min: 0, grade: 'E', descriptor: 'Needs improvement' }],
  Cambridge: [{ min: 90, grade: 'A*' }, { min: 80, grade: 'A' }, { min: 70, grade: 'B' }, { min: 60, grade: 'C' }, { min: 50, grade: 'D' }, { min: 40, grade: 'E' }, { min: 30, grade: 'F' }, { min: 20, grade: 'G' }, { min: 0, grade: 'U', descriptor: 'Ungraded' }],
  ICSE: [{ min: 90, grade: '1' }, { min: 80, grade: '2' }, { min: 70, grade: '3' }, { min: 60, grade: '4' }, { min: 50, grade: '5' }, { min: 40, grade: '6' }, { min: 35, grade: '7' }, { min: 0, grade: '8', descriptor: 'Fail' }],
  IB: [{ min: 85, grade: '7' }, { min: 72, grade: '6' }, { min: 60, grade: '5' }, { min: 48, grade: '4' }, { min: 35, grade: '3' }, { min: 20, grade: '2' }, { min: 0, grade: '1' }],
  'NEP-HPC': [{ min: 75, grade: 'Proficient', descriptor: 'Mountain' }, { min: 50, grade: 'Developing', descriptor: 'Hill' }, { min: 0, grade: 'Beginner', descriptor: 'Stream' }],
  'Pre-school': [{ min: 75, grade: 'Achieved' }, { min: 40, grade: 'Developing' }, { min: 0, grade: 'Emerging' }],
};
SCALES.State = SCALES.CBSE!; SCALES.Mixed = SCALES.CBSE!;

export const SCHEME_CONFIG: Record<string, object> = {
  CBSE: { terms: ['Term 1', 'Term 2'], components: [{ name: 'Periodic Test', weightage: 10, best_of: 2 }, { name: 'Notebook', weightage: 5 }, { name: 'Subject Enrichment', weightage: 5 }, { name: 'Term Exam', weightage: 80 }], pass_percent: 33, rounding: 'nearest', grace_marks: 0, co_scholastic: ['Work Education', 'Art Education', 'Health and Physical Education', 'Discipline'] },
  Cambridge: { terms: ['Term 1', 'Term 2', 'Term 3'], components: [{ name: 'Coursework', weightage: 30 }, { name: 'Checkpoint / Exam', weightage: 70 }], pass_percent: 40, rounding: 'nearest', effort_grades: ['Excellent', 'Good', 'Satisfactory', 'Needs improvement'], remarks: ['homeroom', 'subject'] },
  'NEP-HPC': { terms: ['Term 1', 'Term 2'], components: [{ name: 'Activity', weightage: 50 }, { name: 'Assessment', weightage: 50 }], inputs: ['teacher', 'self', 'peer', 'parent'], stages: ['Foundational', 'Preparatory', 'Middle', 'Secondary'] },
  default: { terms: ['Term 1', 'Term 2'], components: [{ name: 'Internal', weightage: 20 }, { name: 'Term Exam', weightage: 80 }], pass_percent: 35, rounding: 'nearest' },
};
