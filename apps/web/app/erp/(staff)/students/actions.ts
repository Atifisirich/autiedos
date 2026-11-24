'use server';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { go, str, today } from '@/lib/erp/fmt';

export async function admitStudent(fd: FormData) {
  const ctx = await getCtx();
  const sb = ctx.sb;
  const first = str(fd, 'first_name'), dob = str(fd, 'dob'), phone = str(fd, 'g1_phone');
  if (!first) go('/erp/students/new', 'Enter the student name.', 'err');
  // Duplicate checks on student and family (SIS-02)
  if (fd.get('confirm_duplicate') !== 'on' && dob) {
    const { data: dup } = await core(sb).from('students').select('id, first_name, last_name').ilike('first_name', first!).eq('dob', dob).is('deleted_at', null).limit(1);
    if (dup?.length) go('/erp/students/new', `A student named ${dup[0]!.first_name} ${dup[0]!.last_name ?? ''} with this date of birth already exists. Tick "This is not a duplicate" to continue.`, 'err');
  }
  let household = str(fd, 'household_id');
  if (!household && phone) {
    const { data: g } = await core(sb).from('guardians').select('household_id').eq('phone', phone).is('deleted_at', null).limit(1);
    if (g?.length) household = g[0]!.household_id; // existing family: siblings share one household record
  }
  if (!household) {
    const { data: h, error } = await core(sb).from('households').insert({ family_name: `${str(fd, 'last_name') ?? first} family`, address: str(fd, 'address'), city: str(fd, 'city'), phone }).select('id').single();
    if (error) go('/erp/students/new', error.message, 'err');
    household = h!.id as string;
    const guardians = [1, 2].map((n) => ({ household_id: household, name: str(fd, `g${n}_name`), relation: str(fd, `g${n}_relation`) ?? (n === 1 ? 'father' : 'mother'), phone: str(fd, `g${n}_phone`), email: str(fd, `g${n}_email`), is_primary: n === 1 })).filter((g) => g.name);
    if (guardians.length) await core(sb).from('guardians').insert(guardians);
  }
  const sectionId = str(fd, 'section_id');
  const { data: sec } = sectionId ? await core(sb).from('sections').select('id, programme_id, programme:programmes(branch_id)').eq('id', sectionId).single() : { data: null };
  const branchId = ((sec as unknown as { programme: { branch_id: string | null } | null } | null)?.programme?.branch_id) ?? ctx.branchId ?? ctx.orgUser.home_branch_id ?? ctx.branches[0]?.id;
  let admNo = str(fd, 'admission_no');
  if (!admNo) {
    const r = await core(sb).rpc('next_number', { p_key: 'admission_no', p_branch: branchId, p_year: ctx.year?.id ?? null });
    if (r.error) go('/erp/students/new', `No admission number series is set up (${r.error.message}). Type the number, or add a series in Admin console.`, 'err');
    admNo = r.data as string;
  }
  const joined = str(fd, 'joined_on') ?? today();
  const { data: st, error } = await core(sb).from('students').insert({
    household_id: household, branch_id: branchId, admission_no: admNo, first_name: first, last_name: str(fd, 'last_name'), dob, gender: str(fd, 'gender'), status: 'admitted',
    programme_id: (sec as { programme_id?: string } | null)?.programme_id ?? null, section_id: sectionId, roll_no: str(fd, 'roll_no'), house: str(fd, 'house'), mother_tongue: str(fd, 'mother_tongue'),
    apaar_id: str(fd, 'apaar_id'), pen: str(fd, 'pen'), joined_on: joined, previous_school: str(fd, 'previous_school'), rte_quota: fd.get('rte_quota') === 'on', is_new: true,
  }).select('id').single();
  if (error) go('/erp/students/new', error.message, 'err');
  const id = st!.id as string;
  const act = await core(sb).rpc('change_student_status', { p_student: id, p_to: 'active', p_reason: 'Admission', p_effective: joined });
  if (act.error) go(`/erp/students/${id}`, `Admitted, but could not activate: ${act.error.message}`, 'err');
  const sens: Record<string, unknown> = { student_id: id, blood_group: str(fd, 'blood_group'), allergies: str(fd, 'allergies'), social_category: str(fd, 'category')?.toLowerCase() };
  await Promise.all([
    ctx.year ? core(sb).from('enrolments').insert({ student_id: id, academic_year_id: ctx.year.id, programme_id: (sec as { programme_id?: string } | null)?.programme_id ?? null, section_id: sectionId, roll_no: str(fd, 'roll_no') }) : Promise.resolve(),
    ctx.can('sensitive', 'write') && (sens.blood_group || sens.allergies || sens.social_category) ? core(sb).from('student_sensitive').insert(sens) : Promise.resolve(),
    ctx.can('sensitive', 'write') && str(fd, 'emergency_contact') ? erp(sb).rpc('save_student_sensitive', { p_student: id, p_data: { emergency_contact: str(fd, 'emergency_contact') } }) : Promise.resolve(),
    erp(sb).from('post_admission_tasks').insert(['Uniform and book order', 'Transport route selection', 'Medical form', 'ID photo', 'Parent app onboarding'].map((task) => ({ student_id: id, task }))),
  ]);
  go(`/erp/students/${id}`, 'Student admitted. Assign a fee plan from the Fees tab.');
}

export async function changeStatus(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'id')!;
  const to = str(fd, 'to')!;
  const date = str(fd, 'date') ?? today();
  const { error } = await core(ctx.sb).rpc('change_student_status', { p_student: id, p_to: to, p_reason: str(fd, 'reason'), p_effective: date });
  if (error) go(`/erp/students/${id}?tab=timeline`, error.message, 'err');
  // fees, transport, hostel, enrolment and the alumni record follow the status change (MAP B.7)
  if (['withdrawn', 'transferred', 'alumni'].includes(to)) {
    const r = await erp(ctx.sb).rpc('apply_student_exit', { p_student: id, p_to: to, p_date: date });
    if (r.error) go(`/erp/students/${id}?tab=timeline`, `Status changed, but the follow-up failed: ${r.error.message}`, 'err');
  }
  go(`/erp/students/${id}?tab=timeline`, 'Status changed and recorded.');
}

export async function addGrowth(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'student_id')!;
  const pts = str(fd, 'points');
  const { error } = await erp(ctx.sb).from('growth_records').insert({ student_id: id, type: str(fd, 'type'), category: str(fd, 'category'), note: str(fd, 'note'), visibility: str(fd, 'visibility') ?? 'teacher', points: pts ? Number(pts) : null, share_with_parent: fd.get('share_with_parent') === 'on', follow_up_date: str(fd, 'follow_up_date'), recorded_by_name: ctx.name, recorded_by_user_id: ctx.user.id });
  go(`/erp/students/${id}?tab=growth`, error ? error.message : 'Recorded.', error ? 'err' : 'ok');
}

export async function saveSensitive(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'student_id')!;
  const coreRow = Object.fromEntries(['blood_group', 'allergies', 'medical_conditions', 'medications', 'religion'].map((k) => [k, str(fd, k)]));
  const cat = str(fd, 'social_category');
  const a = await core(ctx.sb).from('student_sensitive').upsert({ student_id: id, ...coreRow, social_category: cat ? cat.toLowerCase() : null }, { onConflict: 'org_id,student_id' });
  const b = await erp(ctx.sb).rpc('save_student_sensitive', { p_student: id, p_data: Object.fromEntries(['medical_notes', 'doctor_name', 'doctor_phone', 'emergency_contact', 'vaccination', 'aadhaar_last4'].map((k) => [k, str(fd, k)])) });
  const err = a.error ?? b.error;
  go(`/erp/students/${id}?tab=health`, err ? err.message : 'Saved.', err ? 'err' : 'ok');
}

export async function requestConcession(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'student_id')!;
  const typeId = str(fd, 'type_id');
  const { data: type } = typeId ? await erp(ctx.sb).from('concession_types').select('*').eq('id', typeId).single() : { data: null };
  const kind = str(fd, 'kind') ?? type?.kind ?? 'percent';
  const ov = str(fd, 'value');
  const value = ov ? Number(ov) : Number(type?.value ?? 0);
  const { data: dem } = await erp(ctx.sb).from('fee_demands').select('amount, concession, paid, head:fee_heads(type)').eq('student_id', id).in('status', ['due', 'partial']).is('deleted_at', null);
  const base = ((dem ?? []) as unknown as { amount: number; concession: number; paid: number; head: { type: string } | null }[]).filter((d) => d.head?.type === (type?.head_type ?? 'tuition')).reduce((t, d) => t + Number(d.amount) - Number(d.concession) - Number(d.paid), 0);
  const impact = kind === 'percent' ? Math.round((base * value) / 100) : Math.min(value, base);
  if (type?.max_amount && impact > Number(type.max_amount)) go(`/erp/students/${id}?tab=fees`, `This is above the limit of Rs ${type.max_amount} for ${type.name}.`, 'err');
  const { data: c, error } = await erp(ctx.sb).from('concessions').insert({ student_id: id, academic_year_id: ctx.year?.id, type_id: typeId, kind, value, amount: impact, reason: str(fd, 'reason'), requested_by: ctx.user.id }).select('id').single();
  if (error) go(`/erp/students/${id}?tab=fees`, error.message, 'err');
  const { data: s } = await core(ctx.sb).from('students').select('first_name, last_name').eq('id', id).single();
  const { error: e2 } = await erp(ctx.sb).rpc('submit_approval', { p_type: 'concession', p_object: c!.id, p_title: `${type?.name ?? 'Concession'} for ${s?.first_name} ${s?.last_name ?? ''}`, p_summary: str(fd, 'reason'), p_amount: impact, p_student: id, p_impact: `Reduces open ${type?.head_type ?? 'tuition'} dues by about Rs ${impact.toLocaleString('en-IN')} (${kind === 'percent' ? value + '%' : 'fixed'}).`, p_payload: {} });
  go(`/erp/students/${id}?tab=fees`, e2 ? e2.message : `Concession requested. Effect on dues: about Rs ${impact.toLocaleString('en-IN')}. It applies when approved.`, e2 ? 'err' : 'ok');
}

/** Bulk section transfer with preview on the page; the enrolment row of the year follows the student (SIS-04, GRP-03). */
export async function bulkTransfer(fd: FormData) {
  const ctx = await getCtx();
  const ids = fd.getAll('ids').map(String);
  const to = str(fd, 'to_section');
  if (!ids.length || !to) go('/erp/students/bulk', 'Select students and a destination section.', 'err');
  const { data: sec } = await core(ctx.sb).from('sections').select('id, programme_id, programme:programmes(branch_id)').eq('id', to!).single();
  const house = str(fd, 'house');
  const branch = (sec as unknown as { programme: { branch_id: string | null } | null } | null)?.programme?.branch_id;
  const patch: Record<string, unknown> = { section_id: to, programme_id: sec!.programme_id };
  if (branch) patch.branch_id = branch;
  if (house) patch.house = house;
  const { error } = await core(ctx.sb).from('students').update(patch).in('id', ids);
  if (error) go('/erp/students/bulk', error.message, 'err');
  if (ctx.year) await core(ctx.sb).from('enrolments').update({ section_id: to, programme_id: sec!.programme_id }).in('student_id', ids).eq('academic_year_id', ctx.year.id);
  go('/erp/students/bulk', `${ids.length} students moved. To undo, move them back from the destination section.`);
}
