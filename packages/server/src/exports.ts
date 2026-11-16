/**
 * Exports with school branding: DOCX (question papers, lesson plans) and Excel (timetable,
 * registers, any report table). PDF is produced from the print-friendly web views.
 */
import { AlignmentType, Document, Footer, Header, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import ExcelJS from 'exceljs';
import type { DailyPlan, TemplateSection } from '@autoed/shared';

const p = (text: string, opts: { bold?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; color?: string } = {}) =>
  new Paragraph({ alignment: opts.align, children: [new TextRun({ text, bold: opts.bold, size: opts.size, color: opts.color })] });

function cell(text: string, bold = false) {
  return new TableCell({ children: [p(text, { bold })] });
}

export async function paperDocx(
  paper: { org_name: string; branding: Record<string, string>; class_name: string; subject_name: string; set_no: number; total_marks: number; duration_minutes: number; instructions: string | null; questions: { no: number; section: string; text: string; options?: string[]; marks: number; answer: string; marking: { step: string; marks: number }[] }[] },
  watermark: string,
  withScheme: boolean,
): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    p(paper.branding?.header ?? paper.org_name, { bold: true, size: 32, align: AlignmentType.CENTER }),
    p(`${paper.class_name} · ${paper.subject_name} · Set ${paper.set_no}`, { bold: true, align: AlignmentType.CENTER }),
    p(`Maximum marks: ${paper.total_marks}    Time: ${paper.duration_minutes} minutes`, { align: AlignmentType.CENTER }),
    p('General instructions', { bold: true }),
    p(paper.instructions ?? 'All questions are compulsory.'),
  ];
  let section = '';
  for (const q of paper.questions) {
    if (q.section !== section) {
      section = q.section;
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`Section ${section}`)] }));
    }
    children.push(new Paragraph({ children: [new TextRun({ text: `Q${q.no}. `, bold: true }), new TextRun(q.text), new TextRun({ text: `   [${q.marks}]`, italics: true })] }));
    for (const [i, o] of (q.options ?? []).entries()) children.push(p(`   (${String.fromCharCode(97 + i)}) ${o}`));
  }
  if (withScheme) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Marking scheme')] }));
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ children: [cell('Q', true), cell('Answer', true), cell('Step marks', true)] }), ...paper.questions.map((q) => new TableRow({ children: [cell(String(q.no)), cell(q.answer), cell(q.marking.map((m) => `${m.step}: ${m.marks}`).join('; '))] }))],
      }),
    );
  }
  const doc = new Document({
    sections: [
      {
        headers: { default: new Header({ children: [p(`CONFIDENTIAL · ${watermark}`, { size: 16, color: '999999', align: AlignmentType.RIGHT })] }) },
        footers: { default: new Footer({ children: [p(watermark, { size: 16, color: '999999', align: AlignmentType.CENTER })] }) },
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

function planSection(key: string, plan: Partial<DailyPlan>): (Paragraph | Table)[] {
  const v = (plan as Record<string, unknown>)[key];
  if (v == null) return [];
  switch (key) {
    case 'objectives':
      return (plan.objectives ?? []).map((o) => p(`• ${o.text} (${o.bloom}${o.outcome_codes.length ? `; ${o.outcome_codes.join(', ')}` : ''})`));
    case 'flow':
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: [cell('Phase', true), cell('Min', true), cell('Teacher', true), cell('Students', true)] }), ...(plan.flow ?? []).map((f) => new TableRow({ children: [cell(f.phase.replace('_', ' ')), cell(String(f.minutes)), cell(f.teacher_activity), cell(f.student_activity)] }))],
        }),
      ];
    case 'differentiation':
      return [p(`Support: ${plan.differentiation?.support ?? ''}`), p(`Core: ${plan.differentiation?.core ?? ''}`), p(`Extension: ${plan.differentiation?.extension ?? ''}`)];
    case 'questions':
      return (plan.questions ?? []).map((q) => p(`• ${q.text}${q.level === 'higher' ? ' (HOT)' : ''}`));
    case 'exit_ticket':
      return (plan.exit_ticket ?? []).map((e) => p(`• ${e.question} — ${e.answer}`));
    case 'homework':
      return plan.homework ? [p(`${plan.homework.description} (${plan.homework.minutes} min)`)] : [];
    case 'board_elements': {
      const b = plan.board_elements!;
      return Object.entries(b)
        .filter(([, list]) => (list as string[]).length)
        .map(([k, list]) => p(`${k.replace(/_/g, ' ')}: ${(list as string[]).join('; ')}`));
    }
    default:
      if (Array.isArray(v)) return (v as string[]).map((x) => p(`• ${x}`));
      return [p(String(v))];
  }
}

/** Lesson plan(s) rendered in the school's template order with header; weekly plan = several plans. */
export async function plansDocx(org: { name: string; branding: Record<string, string> }, plans: { title: string; meta: string; content: Partial<DailyPlan>; sections: TemplateSection[] }[]): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [p(org.branding?.header ?? org.name, { bold: true, size: 28, align: AlignmentType.CENTER })];
  for (const pl of plans) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(pl.title)] }), p(pl.meta, { size: 18, color: '555555' }));
    for (const s of [...pl.sections].sort((a, b) => a.seq - b.seq)) {
      const body = planSection(s.key, pl.content);
      if (!body.length && !s.mandatory) continue;
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(s.name)] }), ...body);
    }
  }
  children.push(p('Facts, formulas and answers were generated with AI assistance; the teacher is responsible for final checking.', { size: 16, color: '777777' }));
  const doc = new Document({ sections: [{ footers: { default: new Footer({ children: [p(org.branding?.footer ?? org.name, { size: 16, align: AlignmentType.CENTER })] }) }, children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** Generic branded Excel export of a table. */
export async function tableXlsx(title: string, org: { name: string; branding?: Record<string, string> }, columns: { key: string; header: string; width?: number }[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AutoEd OS';
  const ws = wb.addWorksheet(title.slice(0, 30).replace(/[\\/?*[\]:]/g, ' '));
  ws.addRow([org.branding?.header ?? org.name]).font = { bold: true, size: 14 };
  ws.addRow([title]).font = { bold: true };
  ws.addRow([]);
  const header = ws.addRow(columns.map((c) => c.header));
  header.font = { bold: true };
  header.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });
  for (const r of rows) ws.addRow(columns.map((c) => normalise(r[c.key])));
  columns.forEach((c, i) => (ws.getColumn(i + 1).width = c.width ?? Math.max(12, c.header.length + 2)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function normalise(v: unknown): string | number | boolean | Date | null {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof Date) return v;
  return JSON.stringify(v);
}
