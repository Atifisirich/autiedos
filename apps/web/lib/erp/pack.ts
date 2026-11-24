/**
 * Starter data a new school installs and then adjusts (the source ERP's board and school-type packs, CF-07).
 * Grade scales and scheme defaults come from @autoed/shared/erp (data); this file adds the certificate bodies, message templates and the
 * automation recipes that were not ported with the schema. Installed from Admin console -> Set-up checklist.
 */
const DOC = (title: string, body: string) => `<h2 style="text-align:center">${title}</h2><p>${body}</p><p style="margin-top:48px">Date: {{date}}<span style="float:right">Principal</span></p>`;
export const DOC_TEMPLATES = [
  { type: 'bonafide', name: 'Bonafide certificate', body: DOC('Bonafide Certificate', 'This is to certify that <b>{{student_name}}</b>, admission number {{admission_no}}, child of {{parent_name}}, is a bonafide student of this school studying in {{class}} during the academic year {{year}}. Date of birth as per our records: {{dob}}.') },
  { type: 'study', name: 'Study certificate', body: DOC('Study Certificate', 'This is to certify that <b>{{student_name}}</b> (admission number {{admission_no}}) has been studying in this school since {{joined_on}} and is at present in {{class}}.') },
  { type: 'conduct', name: 'Conduct certificate', body: DOC('Conduct Certificate', 'This is to certify that <b>{{student_name}}</b> of {{class}} has shown good conduct and character during the period of study in this school.') },
  { type: 'no_dues', name: 'No-dues certificate', body: DOC('No Dues Certificate', 'This is to certify that <b>{{student_name}}</b> (admission number {{admission_no}}) of {{class}} has no fee, library, store, transport or hostel dues pending as on {{date}}.') },
  { type: 'fee', name: 'Annual fee certificate', body: DOC('Fee Certificate', 'This is to certify that tuition fees of <b>{{tuition_paid}}</b> were received from {{parent_name}} for <b>{{student_name}}</b> of {{class}} for the academic year {{year}}.') },
  { type: 'tc', name: 'Transfer certificate', body: DOC('Transfer Certificate', '<b>{{student_name}}</b>, child of {{parent_name}}, date of birth {{dob}}, admission number {{admission_no}}, was admitted on {{joined_on}} and left the school on {{left_on}} from {{class}}. All dues to the school have been cleared. Conduct: Good. Reason for leaving: {{reason}}.') },
  { type: 'achievement', name: 'Achievement certificate', body: DOC('Certificate of Achievement', 'Awarded to <b>{{student_name}}</b> of {{class}} for {{reason}}.') },
  { type: 'id_card', name: 'Student ID card', body: '<div style="border:1px solid #999;border-radius:8px;padding:12px;width:240px"><b>{{school}}</b><br/>{{student_name}}<br/>{{class}} · Adm {{admission_no}}<br/>APAAR: {{apaar_id}}<br/>Blood group: {{blood_group}}</div>' },
  { type: 'experience', name: 'Experience letter', body: DOC('Experience Letter', 'This is to certify that <b>{{staff_name}}</b> worked with us as {{designation}} from {{joined_on}} to {{left_on}}.') },
];

export const MESSAGE_TEMPLATES = [
  { event_key: 'absence', name: 'Absent alert', body: '{{student_name}} was marked absent today ({{date}}). Please reply with the reason or apply for leave in the app.' },
  { event_key: 'fee_due', name: 'Fee due', body: 'A fee of {{amount}} for {{student_name}} is due on {{due_date}}. Pay in the app in one tap.' },
  { event_key: 'payment_receipt', name: 'Payment receipt', body: 'We received {{amount}} for {{student_name}}. Receipt {{receipt_no}} is in the app.' },
  { event_key: 'report_card_published', name: 'Report card ready', body: 'The {{term}} report card for {{student_name}} is ready in the app.' },
  { event_key: 'homework_posted', name: 'Homework posted', body: 'New {{type}} for {{class}}: {{title}}' },
  { event_key: 'bus_alert', name: 'Bus alert', body: '{{message}}' },
];

export const DISCIPLINE_RULES = [
  { category: 'Late to class', level: 'Minor', points: 1, consequence: 'Verbal reminder', notify_parent: false }, { category: 'Incomplete homework', level: 'Minor', points: 1, consequence: 'Complete in break' },
  { category: 'Disrespect', level: 'Moderate', points: 3, consequence: 'Meeting with coordinator' }, { category: 'Bullying', level: 'Serious', points: 5, consequence: 'Parent meeting and counselling' },
];
export const REMARKS = [
  { category: 'General', body: 'Shows steady progress and takes pride in presenting work neatly.' }, { category: 'General', body: 'Participates actively in class discussions and works well with peers.' },
  { category: 'Effort', body: 'With more regular revision, results will reflect the understanding shown in class.', tone: 'encouraging' }, { category: 'Concern', body: 'Needs support to complete homework on time; let us work together on a routine.', tone: 'concern' },
];
export const RECIPES = [
  { recipe_key: 'absentee_notice', name: 'Absentee notice', trigger: 'attendance.submitted', actions: [{ do: 'message_parents_of_absentees' }, { do: 'task_class_teacher', after_consecutive: 3 }] },
  { recipe_key: 'attendance_not_marked', name: 'Attendance not marked', trigger: 'time.09:15', actions: [{ do: 'nudge_teacher' }, { do: 'alert_coordinator', at: '09:30' }] },
  { recipe_key: 'fee_reminder_ladder', name: 'Fee reminder ladder', trigger: 'fee.due_date', conditions: { days: [-7, -1, 3, 10], call_task_at: 15 }, actions: [{ do: 'remind_parent' }] },
  { recipe_key: 'cheque_bounced', name: 'Cheque bounced', trigger: 'cheque.bounced', actions: [{ do: 'apply_fine' }, { do: 'notify_parent' }, { do: 'task_accounts' }] },
  { recipe_key: 'concession_approval', name: 'Concession approval', trigger: 'concession.requested', actions: [{ do: 'start_approval' }] },
  { recipe_key: 'leave_and_cover', name: 'Leave and cover', trigger: 'leave.approved', actions: [{ do: 'propose_substitutes' }, { do: 'notify' }] },
  { recipe_key: 'homework_posting_check', name: 'Homework posting check', trigger: 'time.end_of_day', actions: [{ do: 'nudge_teachers_without_posts' }] },
  { recipe_key: 'marks_deadline', name: 'Marks deadline', trigger: 'assessment.deadline', conditions: { days_before: 2 }, actions: [{ do: 'remind_teachers' }, { do: 'status_to_coordinator' }] },
  { recipe_key: 'report_card_publish', name: 'Report-card publish', trigger: 'report_card.signed', actions: [{ do: 'publish' }, { do: 'notify_parents' }] },
  { recipe_key: 'gate_pass', name: 'Gate pass', trigger: 'gate_pass.requested', actions: [{ do: 'start_approval' }, { do: 'otp_to_parent' }] },
  { recipe_key: 'bus_delay', name: 'Bus delay', trigger: 'trip.late', actions: [{ do: 'notify_route_parents' }, { do: 'alert_transport_manager' }] },
  { recipe_key: 'document_expiry', name: 'Document expiry', trigger: 'document.expiry', conditions: { days_before: 30, escalate_at: 7 }, actions: [{ do: 'alert_owner' }] },
  { recipe_key: 'withdrawal_clearance', name: 'Withdrawal clearance', trigger: 'tc.requested', actions: [{ do: 'clearance_tasks' }] },
  { recipe_key: 'birthday_wishes', name: 'Birthday wishes', trigger: 'date.birthday', actions: [{ do: 'greeting' }] },
  { recipe_key: 'year_rollover_reminders', name: 'Year rollover reminders', trigger: 'date.march', actions: [{ do: 'rollover_checklist' }] },
];
export const SUBJECTS: [string, string, string][] = [['English', 'ENG', 'language'], ['Hindi', 'HIN', 'language'], ['Telugu', 'TEL', 'language'], ['Mathematics', 'MAT', 'scholastic'], ['Science', 'SCI', 'scholastic'], ['Social Science', 'SST', 'scholastic'],
  ['Computer Science', 'CS', 'scholastic'], ['Art Education', 'ART', 'co_scholastic'], ['Physical Education', 'PE', 'co_scholastic'], ['Music', 'MUS', 'activity']];
export const GRADES: [string, string][] = [['Nursery', 'pre_primary'], ['LKG', 'pre_primary'], ['UKG', 'pre_primary'], ['Grade 1', 'primary'], ['Grade 2', 'primary'], ['Grade 3', 'primary'], ['Grade 4', 'primary'], ['Grade 5', 'primary'],
  ['Grade 6', 'middle'], ['Grade 7', 'middle'], ['Grade 8', 'middle'], ['Grade 9', 'secondary'], ['Grade 10', 'secondary'], ['Grade 11', 'senior'], ['Grade 12', 'senior']];
export const CHECKLISTS = [
  { name: 'Attendance by cut-off', role: 'class_teacher', frequency: 'daily', check_key: 'attendance_marked' }, { name: 'Homework posted', role: 'subject_teacher', frequency: 'daily', check_key: 'homework_posted' },
  { name: 'Gallery upload', role: 'class_teacher', frequency: 'monthly', check_key: 'gallery_upload' }, { name: 'Marks entered by deadline', role: 'subject_teacher', frequency: 'term', check_key: 'marks_entered' },
];
