/**
 * Preset configuration shipped with AutoEd OS (PRD 4.4 Presets). A preset fills wings,
 * subjects, positions, roles, task categories, leave types, checklists and rubrics.
 */
type L = { hi: string; te: string };

export const PRESET_KEYS = ['cbse', 'cambridge', 'dual'] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

export interface PresetWing {
  name: string;
  board: 'CBSE' | 'CAMBRIDGE' | 'BOTH';
  classes: { name: string; grade: number }[];
  attendanceMode: 'daily_once' | 'daily_twice' | 'period';
}

const range = (from: number, to: number, label: (n: number) => string) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ name: label(from + i), grade: from + i }));

export const PRESET_WINGS: Record<PresetKey, PresetWing[]> = {
  cbse: [
    { name: 'Pre-primary', board: 'CBSE', classes: [{ name: 'Nursery', grade: -2 }, { name: 'LKG', grade: -1 }, { name: 'UKG', grade: 0 }], attendanceMode: 'daily_twice' },
    { name: 'Primary', board: 'CBSE', classes: range(1, 5, (n) => `Class ${n}`), attendanceMode: 'daily_once' },
    { name: 'Middle', board: 'CBSE', classes: range(6, 8, (n) => `Class ${n}`), attendanceMode: 'daily_once' },
    { name: 'Secondary', board: 'CBSE', classes: range(9, 10, (n) => `Class ${n}`), attendanceMode: 'daily_once' },
    { name: 'Senior Secondary', board: 'CBSE', classes: range(11, 12, (n) => `Class ${n}`), attendanceMode: 'period' },
  ],
  cambridge: [
    { name: 'Early Years', board: 'CAMBRIDGE', classes: [{ name: 'Nursery', grade: -2 }, { name: 'Reception', grade: 0 }], attendanceMode: 'daily_twice' },
    { name: 'Primary', board: 'CAMBRIDGE', classes: range(1, 6, (n) => `Stage ${n}`), attendanceMode: 'daily_once' },
    { name: 'Lower Secondary', board: 'CAMBRIDGE', classes: range(7, 9, (n) => `Stage ${n}`), attendanceMode: 'daily_once' },
    { name: 'IGCSE', board: 'CAMBRIDGE', classes: [{ name: 'Year 10', grade: 10 }, { name: 'Year 11', grade: 11 }], attendanceMode: 'period' },
  ],
  dual: [
    { name: 'Pre-primary', board: 'BOTH', classes: [{ name: 'Nursery', grade: -2 }, { name: 'LKG', grade: -1 }, { name: 'UKG', grade: 0 }], attendanceMode: 'daily_twice' },
    { name: 'Primary', board: 'BOTH', classes: range(1, 5, (n) => `Grade ${n}`), attendanceMode: 'daily_once' },
    { name: 'Middle (CBSE)', board: 'CBSE', classes: range(6, 8, (n) => `Class ${n}`), attendanceMode: 'daily_once' },
    { name: 'Lower Secondary (Cambridge)', board: 'CAMBRIDGE', classes: range(6, 8, (n) => `Stage ${n}`), attendanceMode: 'daily_once' },
    { name: 'Secondary (CBSE)', board: 'CBSE', classes: range(9, 10, (n) => `Class ${n}`), attendanceMode: 'daily_once' },
    { name: 'IGCSE', board: 'CAMBRIDGE', classes: [{ name: 'Year 10', grade: 10 }, { name: 'Year 11', grade: 11 }], attendanceMode: 'period' },
  ],
};

export interface PresetSubject {
  code: string;
  name: string;
  department: string;
  language: 'en' | 'hi' | 'te';
  core: boolean;
  periods: number;
  roomType?: string;
  doubles?: number;
}

export const PRESET_DEPARTMENTS = ['Languages', 'Mathematics', 'Science', 'Social Studies', 'Computer Science', 'Physical Education', 'Arts', 'Administration', 'Operations'];

export const PRESET_SUBJECTS: Record<PresetKey, PresetSubject[]> = {
  cbse: [
    { code: 'ENG', name: 'English', department: 'Languages', language: 'en', core: true, periods: 6 },
    { code: 'HIN', name: 'Hindi', department: 'Languages', language: 'hi', core: true, periods: 5 },
    { code: 'TEL', name: 'Telugu', department: 'Languages', language: 'te', core: true, periods: 3 },
    { code: 'MAT', name: 'Mathematics', department: 'Mathematics', language: 'en', core: true, periods: 7 },
    { code: 'SCI', name: 'Science', department: 'Science', language: 'en', core: true, periods: 7, roomType: 'lab', doubles: 1 },
    { code: 'SST', name: 'Social Science', department: 'Social Studies', language: 'en', core: true, periods: 6 },
    { code: 'CS', name: 'Computer Science', department: 'Computer Science', language: 'en', core: false, periods: 2 },
    { code: 'PE', name: 'Physical Education', department: 'Physical Education', language: 'en', core: false, periods: 2 },
    { code: 'ART', name: 'Art', department: 'Arts', language: 'en', core: false, periods: 1 },
    { code: 'LIB', name: 'Library', department: 'Languages', language: 'en', core: false, periods: 1 },
  ],
  cambridge: [
    { code: 'ENG', name: 'English', department: 'Languages', language: 'en', core: true, periods: 6 },
    { code: 'MAT', name: 'Mathematics', department: 'Mathematics', language: 'en', core: true, periods: 6 },
    { code: 'SCI', name: 'Science', department: 'Science', language: 'en', core: true, periods: 6, roomType: 'lab', doubles: 1 },
    { code: 'GP', name: 'Global Perspectives', department: 'Social Studies', language: 'en', core: true, periods: 3 },
    { code: 'HIN', name: 'Hindi', department: 'Languages', language: 'hi', core: true, periods: 4 },
    { code: 'ICT', name: 'Computing', department: 'Computer Science', language: 'en', core: false, periods: 3 },
    { code: 'PE', name: 'Physical Education', department: 'Physical Education', language: 'en', core: false, periods: 3 },
    { code: 'ART', name: 'Art & Design', department: 'Arts', language: 'en', core: false, periods: 2 },
    { code: 'WB', name: 'Wellbeing', department: 'Social Studies', language: 'en', core: false, periods: 1 },
  ],
  dual: [],
};
PRESET_SUBJECTS.dual = [...PRESET_SUBJECTS.cbse, ...PRESET_SUBJECTS.cambridge.filter((s) => !PRESET_SUBJECTS.cbse.some((c) => c.code === s.code))];

export const PRESET_TASK_CATEGORIES: { key: string; name: string; name_i18n: L; color: string; proof: 'none' | 'note' | 'photo' | 'file'; verify: boolean }[] = [
  { key: 'academic', name: 'Academic', name_i18n: { hi: 'शैक्षणिक', te: 'విద్యా' }, color: '#2563eb', proof: 'none', verify: false },
  { key: 'admin', name: 'Administration', name_i18n: { hi: 'प्रशासन', te: 'పరిపాలన' }, color: '#7c3aed', proof: 'none', verify: false },
  { key: 'event', name: 'Event', name_i18n: { hi: 'कार्यक्रम', te: 'కార్యక్రమం' }, color: '#db2777', proof: 'photo', verify: true },
  { key: 'maintenance', name: 'Maintenance', name_i18n: { hi: 'रखरखाव', te: 'నిర్వహణ' }, color: '#ea580c', proof: 'photo', verify: true },
  { key: 'compliance', name: 'Compliance', name_i18n: { hi: 'अनुपालन', te: 'నియమ పాటన' }, color: '#0891b2', proof: 'file', verify: true },
  { key: 'parent', name: 'Parent communication', name_i18n: { hi: 'अभिभावक संवाद', te: 'తల్లిదండ్రుల సంభాషణ' }, color: '#16a34a', proof: 'note', verify: false },
  { key: 'system', name: 'System', name_i18n: { hi: 'सिस्टम', te: 'సిస్టమ్' }, color: '#64748b', proof: 'none', verify: false },
  { key: 'personal', name: 'My work', name_i18n: { hi: 'मेरा काम', te: 'నా పని' }, color: '#475569', proof: 'none', verify: false },
];

export const PRESET_LEAVE_TYPES = [
  { key: 'casual', name: 'Casual leave', name_i18n: { hi: 'आकस्मिक अवकाश', te: 'క్యాజువల్ సెలవు' }, unit: 'day', yearly_quota: 12, accrual: 'monthly', carry_forward: false, carry_forward_max: 0, half_day_allowed: true, notice_days: 1, doc_required_after_days: null, sandwich_rule: false, paid: true },
  { key: 'sick', name: 'Sick leave', name_i18n: { hi: 'चिकित्सा अवकाश', te: 'అనారోగ్య సెలవు' }, unit: 'day', yearly_quota: 10, accrual: 'yearly', carry_forward: true, carry_forward_max: 20, half_day_allowed: true, notice_days: 0, doc_required_after_days: 2, sandwich_rule: false, paid: true },
  { key: 'earned', name: 'Earned leave', name_i18n: { hi: 'अर्जित अवकाश', te: 'ఆర్జిత సెలవు' }, unit: 'day', yearly_quota: 15, accrual: 'monthly', carry_forward: true, carry_forward_max: 30, half_day_allowed: false, notice_days: 7, doc_required_after_days: null, sandwich_rule: true, paid: true },
  { key: 'lop', name: 'Loss of pay', name_i18n: { hi: 'वेतन रहित अवकाश', te: 'జీతం లేని సెలవు' }, unit: 'day', yearly_quota: 0, accrual: 'yearly', carry_forward: false, carry_forward_max: 0, half_day_allowed: true, notice_days: 0, doc_required_after_days: null, sandwich_rule: true, paid: false },
  { key: 'on_duty', name: 'On duty', name_i18n: { hi: 'कार्य पर', te: 'విధి నిమిత్తం' }, unit: 'day', yearly_quota: 0, accrual: 'yearly', carry_forward: false, carry_forward_max: 0, half_day_allowed: true, notice_days: 0, doc_required_after_days: null, sandwich_rule: false, paid: true },
  { key: 'short_permission', name: 'Short permission', name_i18n: { hi: 'अल्प अनुमति', te: 'స్వల్ప అనుమతి' }, unit: 'hour', yearly_quota: 24, accrual: 'monthly', carry_forward: false, carry_forward_max: 0, half_day_allowed: false, notice_days: 0, doc_required_after_days: null, sandwich_rule: false, paid: true },
  { key: 'comp_off', name: 'Compensatory off', name_i18n: { hi: 'प्रतिपूरक अवकाश', te: 'పరిహార సెలవు' }, unit: 'day', yearly_quota: 0, accrual: 'yearly', carry_forward: false, carry_forward_max: 0, half_day_allowed: true, notice_days: 1, doc_required_after_days: null, sandwich_rule: false, paid: true },
  { key: 'maternity', name: 'Maternity leave', name_i18n: { hi: 'मातृत्व अवकाश', te: 'ప్రసూతి సెలవు' }, unit: 'day', yearly_quota: 182, accrual: 'yearly', carry_forward: false, carry_forward_max: 0, half_day_allowed: false, notice_days: 30, doc_required_after_days: 0, sandwich_rule: true, paid: true },
] as const;

type ItemPreset = { label: string; label_i18n: L; type: 'tick' | 'yesno' | 'number' | 'photo' | 'text'; min?: number; max?: number; onFail?: { action: 'ticket'; ticket_category_key: string } | { action: 'task'; role_key: string } };
export const PRESET_CHECKLISTS: { key: string; name: string; name_i18n: L; ownerRole: string; time: string; frequency: 'daily' | 'weekly' | 'monthly'; items: ItemPreset[] }[] = [
  {
    key: 'morning_opening', name: 'Morning opening', name_i18n: { hi: 'सुबह खुलने की जाँच', te: 'ఉదయం ప్రారంభ తనిఖీ' }, ownerRole: 'housekeeping_supervisor', time: '07:30', frequency: 'daily',
    items: [
      { label: 'Gates opened and security present', label_i18n: { hi: 'गेट खुले और सुरक्षा उपस्थित', te: 'గేట్లు తెరిచి భద్రత ఉంది' }, type: 'yesno', onFail: { action: 'task', role_key: 'security_supervisor' } },
      { label: 'Classrooms unlocked and clean', label_i18n: { hi: 'कक्षाएँ खुली और साफ', te: 'తరగతి గదులు తెరిచి శుభ్రంగా ఉన్నాయి' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'housekeeping' } },
      { label: 'Drinking water available', label_i18n: { hi: 'पीने का पानी उपलब्ध', te: 'తాగునీరు అందుబాటులో ఉంది' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'plumbing' } },
      { label: 'Power and fans working', label_i18n: { hi: 'बिजली और पंखे चालू', te: 'విద్యుత్ మరియు ఫ్యాన్లు పనిచేస్తున్నాయి' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'electrical' } },
    ],
  },
  {
    key: 'closing', name: 'Closing', name_i18n: { hi: 'बंद करने की जाँच', te: 'మూసివేత తనిఖీ' }, ownerRole: 'housekeeping_supervisor', time: '17:00', frequency: 'daily',
    items: [
      { label: 'All lights and fans switched off', label_i18n: { hi: 'सभी लाइट और पंखे बंद', te: 'అన్ని లైట్లు, ఫ్యాన్లు ఆఫ్' }, type: 'tick' },
      { label: 'Labs locked', label_i18n: { hi: 'प्रयोगशालाएँ बंद', te: 'ప్రయోగశాలలు తాళం వేశారు' }, type: 'yesno', onFail: { action: 'task', role_key: 'lab_assistant' } },
      { label: 'Taps closed', label_i18n: { hi: 'नल बंद', te: 'కుళాయిలు మూశారు' }, type: 'tick' },
    ],
  },
  {
    key: 'bus_safety', name: 'Bus safety (per bus)', name_i18n: { hi: 'बस सुरक्षा', te: 'బస్ భద్రత' }, ownerRole: 'transport_incharge', time: '07:00', frequency: 'daily',
    items: [
      { label: 'First aid box present', label_i18n: { hi: 'प्राथमिक चिकित्सा बॉक्स मौजूद', te: 'ప్రథమ చికిత్స పెట్టె ఉంది' }, type: 'yesno', onFail: { action: 'task', role_key: 'transport_incharge' } },
      { label: 'Fire extinguisher valid', label_i18n: { hi: 'अग्निशामक वैध', te: 'అగ్నిమాపక యంత్రం చెల్లుబాటులో ఉంది' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'transport' } },
      { label: 'Tyre pressure (psi)', label_i18n: { hi: 'टायर दबाव (psi)', te: 'టైర్ ఒత్తిడి (psi)' }, type: 'number', min: 80, max: 110, onFail: { action: 'ticket', ticket_category_key: 'transport' } },
      { label: 'Attendant on board', label_i18n: { hi: 'परिचारक बस में', te: 'అటెండెంట్ బస్‌లో ఉన్నారు' }, type: 'yesno' },
    ],
  },
  {
    key: 'washroom', name: 'Washroom inspection', name_i18n: { hi: 'शौचालय निरीक्षण', te: 'మరుగుదొడ్ల తనిఖీ' }, ownerRole: 'housekeeping_supervisor', time: '11:00', frequency: 'daily',
    items: [
      { label: 'Clean and dry', label_i18n: { hi: 'साफ और सूखा', te: 'శుభ్రంగా పొడిగా ఉంది' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'housekeeping' } },
      { label: 'Soap and water available', label_i18n: { hi: 'साबुन और पानी उपलब्ध', te: 'సబ్బు, నీరు ఉన్నాయి' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'plumbing' } },
      { label: 'Photo', label_i18n: { hi: 'फोटो', te: 'ఫోటో' }, type: 'photo' },
    ],
  },
  { key: 'lab_safety', name: 'Lab safety', name_i18n: { hi: 'प्रयोगशाला सुरक्षा', te: 'ప్రయోగశాల భద్రత' }, ownerRole: 'lab_assistant', time: '08:00', frequency: 'daily', items: [
    { label: 'Gas cylinders closed', label_i18n: { hi: 'गैस सिलेंडर बंद', te: 'గ్యాస్ సిలిండర్లు మూసి ఉన్నాయి' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'lab' } },
    { label: 'Chemicals labelled and stored', label_i18n: { hi: 'रसायन लेबल और संग्रहित', te: 'రసాయనాలు లేబుల్ చేసి నిల్వ చేశారు' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'lab' } },
    { label: 'Eye-wash station working', label_i18n: { hi: 'आई-वॉश स्टेशन चालू', te: 'ఐ-వాష్ స్టేషన్ పనిచేస్తోంది' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'lab' } },
  ] },
  { key: 'kitchen_water', name: 'Kitchen and water hygiene', name_i18n: { hi: 'रसोई और पानी स्वच्छता', te: 'వంటగది, నీటి పరిశుభ్రత' }, ownerRole: 'housekeeping_supervisor', time: '09:00', frequency: 'daily', items: [
    { label: 'RO filter TDS reading', label_i18n: { hi: 'आरओ फ़िल्टर टीडीएस', te: 'ఆర్‌ఓ ఫిల్టర్ టీడీఎస్' }, type: 'number', min: 50, max: 300, onFail: { action: 'ticket', ticket_category_key: 'plumbing' } },
    { label: 'Kitchen surfaces sanitised', label_i18n: { hi: 'रसोई की सतहें साफ', te: 'వంటగది ఉపరితలాలు శుభ్రపరిచారు' }, type: 'yesno', onFail: { action: 'task', role_key: 'housekeeping_supervisor' } },
  ] },
  { key: 'cctv', name: 'CCTV check', name_i18n: { hi: 'सीसीटीवी जाँच', te: 'సీసీటీవీ తనిఖీ' }, ownerRole: 'it_admin', time: '08:30', frequency: 'daily', items: [
    { label: 'All cameras recording', label_i18n: { hi: 'सभी कैमरे रिकॉर्ड कर रहे हैं', te: 'అన్ని కెమెరాలు రికార్డ్ చేస్తున్నాయి' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'it' } },
    { label: 'Days of storage available', label_i18n: { hi: 'भंडारण के दिन उपलब्ध', te: 'నిల్వ రోజులు' }, type: 'number', min: 15, onFail: { action: 'ticket', ticket_category_key: 'it' } },
  ] },
  { key: 'classroom_ready', name: 'Classroom readiness', name_i18n: { hi: 'कक्षा तैयारी', te: 'తరగతి గది సన్నద్ధత' }, ownerRole: 'housekeeping_supervisor', time: '07:45', frequency: 'daily', items: [
    { label: 'Board clean, markers available', label_i18n: { hi: 'बोर्ड साफ, मार्कर उपलब्ध', te: 'బోర్డు శుభ్రం, మార్కర్లు ఉన్నాయి' }, type: 'tick' },
    { label: 'Smart board working', label_i18n: { hi: 'स्मार्ट बोर्ड चालू', te: 'స్మార్ట్ బోర్డు పనిచేస్తోంది' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'it' } },
  ] },
  { key: 'fire_monthly', name: 'Fire equipment (monthly)', name_i18n: { hi: 'अग्नि उपकरण (मासिक)', te: 'అగ్నిమాపక పరికరాలు (నెలవారీ)' }, ownerRole: 'security_supervisor', time: '10:00', frequency: 'monthly', items: [
    { label: 'Extinguishers within expiry', label_i18n: { hi: 'अग्निशामक समाप्ति तिथि के भीतर', te: 'అగ్నిమాపక యంత్రాల గడువు ఉంది' }, type: 'yesno', onFail: { action: 'ticket', ticket_category_key: 'security' } },
    { label: 'Fire exits clear', label_i18n: { hi: 'आपातकालीन निकास साफ', te: 'అత్యవసర నిష్క్రమణలు ఖాళీగా ఉన్నాయి' }, type: 'yesno', onFail: { action: 'task', role_key: 'security_supervisor' } },
    { label: 'Alarm tested', label_i18n: { hi: 'अलार्म परीक्षण किया', te: 'అలారం పరీక్షించారు' }, type: 'tick' },
  ] },
];

export const PRESET_TICKET_CATEGORIES: { key: string; name: string; name_i18n: L; ownerRole: string }[] = [
  { key: 'it', name: 'IT', name_i18n: { hi: 'आईटी', te: 'ఐటీ' }, ownerRole: 'it_admin' },
  { key: 'electrical', name: 'Electrical', name_i18n: { hi: 'बिजली', te: 'విద్యుత్' }, ownerRole: 'housekeeping_supervisor' },
  { key: 'plumbing', name: 'Plumbing', name_i18n: { hi: 'प्लंबिंग', te: 'ప్లంబింగ్' }, ownerRole: 'housekeeping_supervisor' },
  { key: 'furniture', name: 'Furniture', name_i18n: { hi: 'फर्नीचर', te: 'ఫర్నిచర్' }, ownerRole: 'housekeeping_supervisor' },
  { key: 'housekeeping', name: 'Housekeeping', name_i18n: { hi: 'सफाई', te: 'హౌస్‌కీపింగ్' }, ownerRole: 'housekeeping_supervisor' },
  { key: 'transport', name: 'Transport', name_i18n: { hi: 'परिवहन', te: 'రవాణా' }, ownerRole: 'transport_incharge' },
  { key: 'lab', name: 'Lab', name_i18n: { hi: 'प्रयोगशाला', te: 'ప్రయోగశాల' }, ownerRole: 'lab_assistant' },
  { key: 'security', name: 'Security', name_i18n: { hi: 'सुरक्षा', te: 'భద్రత' }, ownerRole: 'security_supervisor' },
  { key: 'other', name: 'Other', name_i18n: { hi: 'अन्य', te: 'ఇతర' }, ownerRole: 'admin_officer' },
];

export const PRESET_RUBRIC = {
  name: 'Classroom observation (standard)',
  scale: { min: 1, max: 4, labels: ['Beginning', 'Developing', 'Proficient', 'Exemplary'] },
  domains: [
    { key: 'delivery', name: 'Lesson delivery', weight: 30, indicators: [{ key: 'objectives', text: 'Objectives shared and revisited' }, { key: 'explanation', text: 'Clear explanation with examples' }, { key: 'pacing', text: 'Pacing fits the period' }] },
    { key: 'management', name: 'Classroom management', weight: 20, indicators: [{ key: 'routines', text: 'Routines established' }, { key: 'behaviour', text: 'Behaviour managed positively' }] },
    { key: 'engagement', name: 'Student engagement', weight: 20, indicators: [{ key: 'participation', text: 'Most students participate' }, { key: 'questioning', text: 'Higher-order questioning' }] },
    { key: 'assessment', name: 'Assessment practice', weight: 20, indicators: [{ key: 'checks', text: 'Checks for understanding' }, { key: 'feedback', text: 'Specific feedback to students' }] },
    { key: 'conduct', name: 'Professional conduct', weight: 10, indicators: [{ key: 'punctual', text: 'Punctual and prepared' }, { key: 'records', text: 'Records up to date' }] },
  ],
};

export const PRESET_EVENT_TEMPLATES: { key: string; name: string; name_i18n: L; tasks: { title: string; role_key: string; days_before: number; priority: 'normal' | 'high' }[]; committees: string[]; budget: { line: string; amount: number }[] }[] = [
  { key: 'annual_day', name: 'Annual Day', name_i18n: { hi: 'वार्षिकोत्सव', te: 'వార్షికోత్సవం' }, committees: ['Stage', 'Programme', 'Hospitality', 'Discipline'], budget: [{ line: 'Stage and sound', amount: 80000 }, { line: 'Costumes', amount: 40000 }],
    tasks: [
      { title: 'Finalise programme list', role_key: 'academic_coordinator', days_before: 45, priority: 'high' },
      { title: 'Book stage, sound and lights', role_key: 'admin_officer', days_before: 30, priority: 'high' },
      { title: 'Rehearsal schedule shared', role_key: 'academic_coordinator', days_before: 21, priority: 'normal' },
      { title: 'Invitations to parents and guests', role_key: 'admin_officer', days_before: 14, priority: 'normal' },
      { title: 'Seating and discipline plan', role_key: 'vice_principal', days_before: 7, priority: 'normal' },
    ] },
  { key: 'sports_day', name: 'Sports Day', name_i18n: { hi: 'खेल दिवस', te: 'క్రీడా దినోత్సవం' }, committees: ['Track', 'First aid', 'Results'], budget: [{ line: 'Medals and trophies', amount: 25000 }],
    tasks: [
      { title: 'Event list and heats', role_key: 'subject_teacher', days_before: 21, priority: 'normal' },
      { title: 'Ground marking', role_key: 'housekeeping_supervisor', days_before: 3, priority: 'high' },
      { title: 'First-aid station', role_key: 'admin_officer', days_before: 2, priority: 'high' },
    ] },
  { key: 'ptm', name: 'Parent-teacher meeting', name_i18n: { hi: 'अभिभावक-शिक्षक बैठक', te: 'తల్లిదండ్రుల-ఉపాధ్యాయుల సమావేశం' }, committees: ['Reception'], budget: [],
    tasks: [
      { title: 'Share PTM schedule with parents', role_key: 'admin_officer', days_before: 7, priority: 'normal' },
      { title: 'Prepare student progress notes', role_key: 'class_teacher', days_before: 3, priority: 'high' },
    ] },
  { key: 'field_trip', name: 'Field trip', name_i18n: { hi: 'शैक्षिक भ्रमण', te: 'క్షేత్ర పర్యటన' }, committees: ['Logistics'], budget: [{ line: 'Bus hire', amount: 15000 }],
    tasks: [
      { title: 'Collect consent forms', role_key: 'class_teacher', days_before: 10, priority: 'high' },
      { title: 'Book transport', role_key: 'transport_incharge', days_before: 7, priority: 'high' },
      { title: 'Trip checklist and headcount plan', role_key: 'class_teacher', days_before: 1, priority: 'high' },
    ] },
  { key: 'science_exhibition', name: 'Science exhibition', name_i18n: { hi: 'विज्ञान प्रदर्शनी', te: 'సైన్స్ ఎగ్జిబిషన్' }, committees: ['Judging', 'Setup'], budget: [{ line: 'Materials', amount: 20000 }],
    tasks: [
      { title: 'Project list approved', role_key: 'hod', days_before: 30, priority: 'normal' },
      { title: 'Hall layout', role_key: 'admin_officer', days_before: 5, priority: 'normal' },
    ] },
  { key: 'independence_day', name: 'Independence Day', name_i18n: { hi: 'स्वतंत्रता दिवस', te: 'స్వాతంత్ర్య దినోత్సవం' }, committees: ['Programme'], budget: [{ line: 'Decoration', amount: 8000 }],
    tasks: [
      { title: 'Flag hoisting arrangements', role_key: 'admin_officer', days_before: 5, priority: 'high' },
      { title: 'Cultural programme', role_key: 'academic_coordinator', days_before: 14, priority: 'normal' },
    ] },
  { key: 'admissions_open_day', name: 'Admissions open day', name_i18n: { hi: 'प्रवेश खुला दिवस', te: 'ప్రవేశాల ఓపెన్ డే' }, committees: ['Tours', 'Counselling'], budget: [{ line: 'Brochures', amount: 10000 }],
    tasks: [
      { title: 'Campus tour route and guides', role_key: 'admin_officer', days_before: 10, priority: 'normal' },
      { title: 'Classroom showcase', role_key: 'academic_coordinator', days_before: 5, priority: 'normal' },
    ] },
];

export const PRESET_DUTY_TYPES: { key: string; name: string; name_i18n: L; starts_at: string; ends_at: string; staff: number; overlapsPeriod?: number }[] = [
  { key: 'gate', name: 'Gate duty', name_i18n: { hi: 'गेट ड्यूटी', te: 'గేట్ డ్యూటీ' }, starts_at: '07:40', ends_at: '08:10', staff: 2 },
  { key: 'bus_bay', name: 'Bus bay', name_i18n: { hi: 'बस बे', te: 'బస్ బే' }, starts_at: '15:20', ends_at: '15:50', staff: 2 },
  { key: 'assembly', name: 'Assembly', name_i18n: { hi: 'प्रार्थना सभा', te: 'ప్రార్థన సమావేశం' }, starts_at: '08:10', ends_at: '08:30', staff: 1 },
  { key: 'corridor', name: 'Corridor', name_i18n: { hi: 'गलियारा', te: 'కారిడార్' }, starts_at: '10:40', ends_at: '11:00', staff: 2 },
  { key: 'lunch', name: 'Lunch', name_i18n: { hi: 'भोजन', te: 'భోజనం' }, starts_at: '12:20', ends_at: '13:00', staff: 2 },
  { key: 'playground', name: 'Playground', name_i18n: { hi: 'खेल का मैदान', te: 'ఆట స్థలం' }, starts_at: '12:20', ends_at: '13:00', staff: 1 },
  { key: 'dispersal', name: 'Dispersal', name_i18n: { hi: 'छुट्टी के समय', te: 'విడుదల సమయం' }, starts_at: '15:20', ends_at: '15:50', staff: 2 },
  { key: 'exam_relief', name: 'Exam relief', name_i18n: { hi: 'परीक्षा राहत', te: 'పరీక్ష రిలీఫ్' }, starts_at: '09:00', ends_at: '12:00', staff: 0 },
];

/** Labelled "verify against current board and state rules" (PRD 7.8). */
export const PRESET_COMPLIANCE: Record<'cbse' | 'cambridge', { name: string; category: string; months: number }[]> = {
  cbse: [
    { name: 'CBSE affiliation renewal', category: 'Affiliation', months: 60 },
    { name: 'Fire safety certificate', category: 'Safety', months: 12 },
    { name: 'Building safety certificate', category: 'Safety', months: 60 },
    { name: 'Water test report', category: 'Health', months: 6 },
    { name: 'Bus fitness certificate', category: 'Transport', months: 12 },
    { name: 'Bus permit', category: 'Transport', months: 12 },
    { name: 'Driver licence verification', category: 'Transport', months: 12 },
    { name: 'Insurance (building and students)', category: 'Insurance', months: 12 },
    { name: 'Staff police verification', category: 'People', months: 36 },
    { name: 'School Management Committee meeting', category: 'Committees', months: 3 },
    { name: 'POCSO committee meeting', category: 'Committees', months: 3 },
  ],
  cambridge: [
    { name: 'Cambridge centre registration', category: 'Affiliation', months: 12 },
    { name: 'State NOC', category: 'Affiliation', months: 60 },
    { name: 'Fire safety certificate', category: 'Safety', months: 12 },
    { name: 'Building safety certificate', category: 'Safety', months: 60 },
    { name: 'Water test report', category: 'Health', months: 6 },
    { name: 'Bus fitness certificate', category: 'Transport', months: 12 },
    { name: 'Insurance (building and students)', category: 'Insurance', months: 12 },
    { name: 'Staff background verification', category: 'People', months: 36 },
    { name: 'Safeguarding committee meeting', category: 'Committees', months: 3 },
  ],
};

export const PRESET_EXAM_TYPES: Record<'cbse' | 'cambridge', { key: string; name: string; name_i18n: L }[]> = {
  cbse: [
    { key: 'periodic_test', name: 'Periodic test', name_i18n: { hi: 'आवधिक परीक्षा', te: 'ఆవర్తన పరీక్ష' } },
    { key: 'unit_test', name: 'Unit test', name_i18n: { hi: 'इकाई परीक्षा', te: 'యూనిట్ పరీక్ష' } },
    { key: 'term_exam', name: 'Term exam', name_i18n: { hi: 'सत्र परीक्षा', te: 'టర్మ్ పరీక్ష' } },
    { key: 'pre_board', name: 'Pre-board', name_i18n: { hi: 'प्री-बोर्ड', te: 'ప్రీ-బోర్డ్' } },
    { key: 'practical', name: 'Practical', name_i18n: { hi: 'प्रायोगिक', te: 'ప్రాక్టికల్' } },
  ],
  cambridge: [
    { key: 'progression', name: 'Progression test', name_i18n: { hi: 'प्रगति परीक्षा', te: 'ప్రోగ్రెషన్ పరీక్ష' } },
    { key: 'checkpoint_practice', name: 'Checkpoint practice', name_i18n: { hi: 'चेकपॉइंट अभ्यास', te: 'చెక్‌పాయింట్ అభ్యాసం' } },
    { key: 'mock', name: 'Mock', name_i18n: { hi: 'मॉक', te: 'మాక్' } },
    { key: 'term_exam', name: 'Term exam', name_i18n: { hi: 'सत्र परीक्षा', te: 'టర్మ్ పరీక్ష' } },
  ],
};

export const QUESTION_TYPES: Record<'CBSE' | 'CAMBRIDGE', { key: string; name: string }[]> = {
  CBSE: [
    { key: 'mcq', name: 'MCQ' },
    { key: 'assertion_reason', name: 'Assertion-reason' },
    { key: 'case_based', name: 'Case or source-based' },
    { key: 'very_short', name: 'Very short answer' },
    { key: 'short', name: 'Short answer' },
    { key: 'long', name: 'Long answer' },
    { key: 'map_diagram', name: 'Map / diagram' },
  ],
  CAMBRIDGE: [
    { key: 'multiple_choice', name: 'Multiple choice' },
    { key: 'structured', name: 'Structured' },
    { key: 'extended', name: 'Extended response' },
    { key: 'practical', name: 'Practical / alternative to practical' },
  ],
};

/** Approval request types. System types back leave, regularisation, swaps and edits. */
export const PRESET_APPROVAL_TYPES: { key: string; name: string; name_i18n: L; system: boolean; form: { key: string; label: string; type: 'text' | 'number' | 'date' | 'dropdown' | 'yesno' | 'file'; required: boolean; options?: string[] }[]; steps: { seq: number; kind: 'role' | 'manager_of_applicant'; role?: string; condition?: { field: string; op: '>'; value: number } }[]; taskTemplate?: { title: string; role_key?: string; days_after: number }[] }[] = [
  { key: 'leave', name: 'Leave', name_i18n: { hi: 'अवकाश', te: 'సెలవు' }, system: true, form: [], steps: [{ seq: 1, kind: 'manager_of_applicant' }, { seq: 2, kind: 'role', role: 'principal' }] },
  { key: 'regularisation', name: 'Attendance regularisation', name_i18n: { hi: 'उपस्थिति नियमितीकरण', te: 'హాజరు క్రమబద్ధీకరణ' }, system: true, form: [], steps: [{ seq: 1, kind: 'manager_of_applicant' }] },
  { key: 'attendance_edit', name: 'Student attendance edit', name_i18n: { hi: 'छात्र उपस्थिति संशोधन', te: 'విద్యార్థి హాజరు సవరణ' }, system: true, form: [], steps: [{ seq: 1, kind: 'role', role: 'academic_coordinator' }] },
  { key: 'duty_swap', name: 'Duty swap', name_i18n: { hi: 'ड्यूटी अदला-बदली', te: 'డ్యూటీ మార్పిడి' }, system: true, form: [], steps: [{ seq: 1, kind: 'role', role: 'academic_coordinator' }] },
  { key: 'invigilation_swap', name: 'Invigilation swap', name_i18n: { hi: 'निरीक्षण अदला-बदली', te: 'ఇన్విజిలేషన్ మార్పిడి' }, system: true, form: [], steps: [{ seq: 1, kind: 'role', role: 'academic_coordinator' }] },
  { key: 'ticket_cost', name: 'Maintenance cost', name_i18n: { hi: 'रखरखाव लागत', te: 'నిర్వహణ ఖర్చు' }, system: true, form: [{ key: 'amount', label: 'Amount', type: 'number', required: true }], steps: [{ seq: 1, kind: 'role', role: 'principal' }, { seq: 2, kind: 'role', role: 'director', condition: { field: 'amount', op: '>', value: 25000 } }] },
  { key: 'event_budget', name: 'Event budget', name_i18n: { hi: 'कार्यक्रम बजट', te: 'కార్యక్రమ బడ్జెట్' }, system: true, form: [{ key: 'amount', label: 'Amount', type: 'number', required: true }], steps: [{ seq: 1, kind: 'role', role: 'principal' }, { seq: 2, kind: 'role', role: 'director', condition: { field: 'amount', op: '>', value: 50000 } }] },
  { key: 'purchase', name: 'Purchase', name_i18n: { hi: 'खरीद', te: 'కొనుగోలు' }, system: false, form: [{ key: 'item', label: 'Item', type: 'text', required: true }, { key: 'amount', label: 'Amount', type: 'number', required: true }, { key: 'vendor', label: 'Vendor', type: 'text', required: false }], steps: [{ seq: 1, kind: 'manager_of_applicant' }, { seq: 2, kind: 'role', role: 'principal' }, { seq: 3, kind: 'role', role: 'director', condition: { field: 'amount', op: '>', value: 10000 } }] },
  { key: 'reimbursement', name: 'Reimbursement', name_i18n: { hi: 'प्रतिपूर्ति', te: 'తిరిగి చెల్లింపు' }, system: false, form: [{ key: 'amount', label: 'Amount', type: 'number', required: true }, { key: 'bill', label: 'Bill', type: 'file', required: true }], steps: [{ seq: 1, kind: 'manager_of_applicant' }, { seq: 2, kind: 'role', role: 'accountant' }] },
  { key: 'event_proposal', name: 'Event proposal', name_i18n: { hi: 'कार्यक्रम प्रस्ताव', te: 'కార్యక్రమ ప్రతిపాదన' }, system: false, form: [{ key: 'date', label: 'Date', type: 'date', required: true }, { key: 'details', label: 'Details', type: 'text', required: true }], steps: [{ seq: 1, kind: 'role', role: 'principal' }] },
  { key: 'field_trip', name: 'Field trip', name_i18n: { hi: 'शैक्षिक भ्रमण', te: 'క్షేత్ర పర్యటన' }, system: false, form: [{ key: 'date', label: 'Date', type: 'date', required: true }, { key: 'destination', label: 'Destination', type: 'text', required: true }, { key: 'students', label: 'Number of students', type: 'number', required: true }], steps: [{ seq: 1, kind: 'manager_of_applicant' }, { seq: 2, kind: 'role', role: 'principal' }], taskTemplate: [{ title: 'Collect consent forms', days_after: 0 }, { title: 'Trip checklist and headcount plan', days_after: 1 }] },
  { key: 'gate_pass', name: 'Gate pass', name_i18n: { hi: 'गेट पास', te: 'గేట్ పాస్' }, system: false, form: [{ key: 'time', label: 'Time out', type: 'text', required: true }, { key: 'reason', label: 'Reason', type: 'text', required: true }], steps: [{ seq: 1, kind: 'manager_of_applicant' }] },
  { key: 'room_booking', name: 'Room booking', name_i18n: { hi: 'कक्ष बुकिंग', te: 'గది బుకింగ్' }, system: false, form: [{ key: 'room', label: 'Room', type: 'text', required: true }, { key: 'date', label: 'Date', type: 'date', required: true }], steps: [{ seq: 1, kind: 'role', role: 'admin_officer' }] },
  { key: 'stock_request', name: 'Stock request', name_i18n: { hi: 'स्टॉक अनुरोध', te: 'స్టాక్ అభ్యర్థన' }, system: false, form: [{ key: 'item', label: 'Item', type: 'text', required: true }, { key: 'quantity', label: 'Quantity', type: 'number', required: true }], steps: [{ seq: 1, kind: 'role', role: 'admin_officer' }] },
];

/** Notification events and default channels (PRD 8.4). */
export const NOTIFICATION_EVENTS: { key: string; channels: ('inapp' | 'push' | 'whatsapp')[]; optional: boolean; urgent: boolean; whatsappTemplate?: string }[] = [
  { key: 'task.assigned', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'task.assigned_urgent', channels: ['inapp', 'push', 'whatsapp'], optional: false, urgent: true, whatsappTemplate: 'os_urgent_task' },
  { key: 'task.requested', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'task.comment', channels: ['inapp', 'push'], optional: true, urgent: false },
  { key: 'task.status', channels: ['inapp', 'push'], optional: true, urgent: false },
  { key: 'task.reminder', channels: ['inapp', 'push'], optional: true, urgent: false },
  { key: 'task.escalation', channels: ['inapp', 'push', 'whatsapp'], optional: false, urgent: false, whatsappTemplate: 'os_escalation' },
  { key: 'task.day_close', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'substitution.assigned', channels: ['inapp', 'push', 'whatsapp'], optional: false, urgent: true, whatsappTemplate: 'os_substitution' },
  { key: 'substitution.uncovered', channels: ['inapp', 'push'], optional: false, urgent: true },
  { key: 'leave.decision', channels: ['inapp', 'push', 'whatsapp'], optional: false, urgent: false, whatsappTemplate: 'os_leave_decision' },
  { key: 'approval.pending', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'approval.decision', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'attendance.unmarked', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'checklist.missed', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'circular.new', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'circular.important', channels: ['inapp', 'push', 'whatsapp'], optional: false, urgent: false, whatsappTemplate: 'os_circular' },
  { key: 'incident.critical', channels: ['inapp', 'push', 'whatsapp'], optional: false, urgent: true, whatsappTemplate: 'os_critical_incident' },
  { key: 'digest.daily', channels: ['inapp', 'push', 'whatsapp'], optional: false, urgent: false, whatsappTemplate: 'os_daily_digest' },
  { key: 'coverage.at_risk', channels: ['inapp', 'push'], optional: true, urgent: false },
  { key: 'plan.review', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'compliance.reminder', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'duty.reminder', channels: ['inapp', 'push'], optional: true, urgent: false },
  { key: 'ticket.update', channels: ['inapp', 'push'], optional: true, urgent: false },
  { key: 'meeting.scheduled', channels: ['inapp', 'push'], optional: true, urgent: false },
  { key: 'observation.shared', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'credits.warning', channels: ['inapp', 'push'], optional: false, urgent: false },
  { key: 'paper.review', channels: ['inapp', 'push'], optional: false, urgent: false },
];

export const PRESET_APPRAISAL_WEIGHTS = { observation: 30, task_on_time: 15, plan_timeliness: 15, syllabus_coverage: 10, class_log_compliance: 10, punctuality: 10, training_hours: 5, self_appraisal: 0, manager_rating: 5 };
