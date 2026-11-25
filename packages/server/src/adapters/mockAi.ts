/**
 * Deterministic mock AI used in development and tests (production uses Gemini, see adapters/ai.ts). It returns structured
 * output in the same shape the real model is asked for, built from curriculum context,
 * so every screen and flow can be exercised end to end.
 */
import { mockDesignerPlan } from '@autoed/shared';

type Ctx = Record<string, unknown>;
type Outcome = { code: string; text: string };

const PHRASES = {
  en: {
    hook: (t: string) => `Pose a real-life question about ${t} and take three quick answers`,
    hookS: 'Think-pair-share on the question',
    teach: (t: string) => `Explain ${t} step by step with a worked example on the board`,
    teachS: 'Note key points and ask clarifying questions',
    guided: 'Pairs solve two practice items while the teacher circulates',
    guidedS: 'Work in pairs; compare answers',
    indep: 'Set an individual task and check three students’ work',
    indepS: 'Complete the task independently',
    close: 'Recap the objectives and run the exit ticket',
    closeS: 'Answer the exit ticket',
    prior: (t: string) => `What do you already know about ${t}?`,
    materials: ['Whiteboard and markers', 'Textbook', 'Worksheet'],
    support: 'Give a partly solved example and a word bank',
    core: 'Complete the standard practice items',
    extension: 'Create and solve one new problem of your own',
    q1: (t: string) => `How would you explain ${t} to a younger student?`,
    q2: (t: string) => `Where do you see ${t} in daily life in India?`,
    exitQ: (t: string) => `Write one key idea about ${t}.`,
    exitA: 'Any correct key idea from today’s lesson',
    hw: (t: string) => `Answer three short questions on ${t}`,
    link: (t: string) => `Connect ${t} to an everyday example from the local market or home`,
    board: (t: string) => `${t}: key terms, one worked example, summary`,
  },
  hi: {
    hook: (t: string) => `${t} से जुड़ा एक दैनिक जीवन का प्रश्न पूछें और तीन उत्तर लें`,
    hookS: 'प्रश्न पर साथी से चर्चा करें',
    teach: (t: string) => `${t} को उदाहरण सहित चरणबद्ध समझाएँ`,
    teachS: 'मुख्य बिंदु लिखें और प्रश्न पूछें',
    guided: 'जोड़ियों में दो अभ्यास प्रश्न हल करवाएँ',
    guidedS: 'जोड़ी में काम करें और उत्तर मिलाएँ',
    indep: 'व्यक्तिगत कार्य दें और तीन छात्रों का काम जाँचें',
    indepS: 'स्वयं कार्य पूरा करें',
    close: 'उद्देश्यों को दोहराएँ और निकास प्रश्न दें',
    closeS: 'निकास प्रश्न का उत्तर दें',
    prior: (t: string) => `${t} के बारे में आप पहले से क्या जानते हैं?`,
    materials: ['श्यामपट्ट', 'पाठ्यपुस्तक', 'कार्यपत्रक'],
    support: 'आंशिक रूप से हल किया गया उदाहरण और शब्द-सूची दें',
    core: 'मानक अभ्यास प्रश्न हल करें',
    extension: 'अपना एक नया प्रश्न बनाकर हल करें',
    q1: (t: string) => `आप ${t} को छोटे छात्र को कैसे समझाएँगे?`,
    q2: (t: string) => `दैनिक जीवन में ${t} कहाँ दिखाई देता है?`,
    exitQ: (t: string) => `${t} के बारे में एक मुख्य बात लिखिए।`,
    exitA: 'आज के पाठ की कोई भी सही मुख्य बात',
    hw: (t: string) => `${t} पर तीन लघु प्रश्नों के उत्तर लिखिए`,
    link: (t: string) => `${t} को घर या बाज़ार के उदाहरण से जोड़ें`,
    board: (t: string) => `${t}: मुख्य शब्द, एक उदाहरण, सारांश`,
  },
  te: {
    hook: (t: string) => `${t} గురించి ఒక నిజ జీవిత ప్రశ్న అడిగి మూడు సమాధానాలు తీసుకోండి`,
    hookS: 'ప్రశ్నపై తోటి విద్యార్థితో చర్చించండి',
    teach: (t: string) => `${t}ను ఉదాహరణతో దశలవారీగా వివరించండి`,
    teachS: 'ముఖ్య అంశాలు రాసుకోండి, సందేహాలు అడగండి',
    guided: 'జంటలుగా రెండు అభ్యాస ప్రశ్నలు చేయించండి',
    guidedS: 'జంటగా పని చేసి సమాధానాలు పోల్చండి',
    indep: 'వ్యక్తిగత పని ఇచ్చి ముగ్గురి పనిని తనిఖీ చేయండి',
    indepS: 'స్వయంగా పని పూర్తి చేయండి',
    close: 'లక్ష్యాలను పునశ్చరణ చేసి ఎగ్జిట్ ప్రశ్న ఇవ్వండి',
    closeS: 'ఎగ్జిట్ ప్రశ్నకు సమాధానం ఇవ్వండి',
    prior: (t: string) => `${t} గురించి మీకు ముందే ఏమి తెలుసు?`,
    materials: ['నల్లబల్ల', 'పాఠ్యపుస్తకం', 'వర్క్‌షీట్'],
    support: 'పాక్షికంగా చేసిన ఉదాహరణ, పదాల జాబితా ఇవ్వండి',
    core: 'సాధారణ అభ్యాస ప్రశ్నలు చేయండి',
    extension: 'మీ సొంత ప్రశ్న తయారు చేసి సాధించండి',
    q1: (t: string) => `${t}ను చిన్న విద్యార్థికి ఎలా వివరిస్తారు?`,
    q2: (t: string) => `రోజువారీ జీవితంలో ${t} ఎక్కడ కనిపిస్తుంది?`,
    exitQ: (t: string) => `${t} గురించి ఒక ముఖ్య విషయం రాయండి.`,
    exitA: 'నేటి పాఠంలోని ఏదైనా సరైన ముఖ్య విషయం',
    hw: (t: string) => `${t}పై మూడు చిన్న ప్రశ్నలకు సమాధానాలు రాయండి`,
    link: (t: string) => `${t}ను ఇంటి లేదా మార్కెట్ ఉదాహరణతో అనుసంధానించండి`,
    board: (t: string) => `${t}: ముఖ్య పదాలు, ఒక ఉదాహరణ, సారాంశం`,
  },
} as const;

type LangKey = keyof typeof PHRASES;
const lang = (c: Ctx): LangKey => (c.language === 'hi' || c.language === 'te' ? c.language : 'en');

function split(total: number, parts: number[]): number[] {
  const sum = parts.reduce((s, x) => s + x, 0);
  const raw = parts.map((p) => Math.max(1, Math.floor((p * total) / sum)));
  let diff = total - raw.reduce((s, x) => s + x, 0);
  let i = 1;
  while (diff !== 0) {
    raw[i % raw.length]! += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
    i++;
  }
  return raw;
}

function dailyPlan(c: Ctx) {
  const L = PHRASES[lang(c)];
  const topic = String(c.topic ?? 'the topic');
  const outcomes = (c.outcomes as Outcome[] | undefined) ?? [];
  const total = Number(c.periodMinutes ?? 40) * Number(c.periodCount ?? 1);
  const [a, b, g, i, z] = split(total, [10, 30, 25, 20, 15]);
  const board = String(c.board ?? 'CBSE');
  const objectives = (outcomes.length ? outcomes : [{ code: '', text: topic }]).slice(0, 3).map((o, k) => ({ text: o.text, bloom: (['understand', 'apply', 'analyse'] as const)[k] ?? 'apply', outcome_codes: o.code ? [o.code] : [] }));
  return {
    objectives,
    board_elements:
      board === 'CAMBRIDGE'
        ? { competencies: [], nep_elements: [], key_vocabulary: topic.split(/[\s:–-]+/).filter((w) => w.length > 4).slice(0, 4), success_criteria: objectives.map((o) => `I can ${o.text.charAt(0).toLowerCase()}${o.text.slice(1)}`), assessment_objectives: ['AO1 Knowledge and understanding', 'AO2 Application'] }
        : { competencies: ((c.competencies as string[]) ?? []).slice(0, 2), nep_elements: ['Experiential learning', 'Life skills: collaboration'], key_vocabulary: [], success_criteria: [], assessment_objectives: [] },
    prior_knowledge: [L.prior(topic)],
    materials: [...L.materials, ...((c.resources as string[]) ?? []).filter((r) => r !== 'none')],
    flow: [
      { phase: 'opening', minutes: a, teacher_activity: L.hook(topic), student_activity: L.hookS },
      { phase: 'teaching', minutes: b, teacher_activity: L.teach(topic), student_activity: L.teachS },
      { phase: 'guided_practice', minutes: g, teacher_activity: L.guided, student_activity: L.guidedS },
      { phase: 'independent_practice', minutes: i, teacher_activity: L.indep, student_activity: L.indepS },
      { phase: 'closure', minutes: z, teacher_activity: L.close, student_activity: L.closeS },
    ],
    differentiation: { support: L.support, core: L.core, extension: L.extension },
    questions: [
      { text: L.q1(topic), level: 'higher', competency: true },
      { text: L.q2(topic), level: 'higher', competency: true },
    ],
    exit_ticket: [{ question: L.exitQ(topic), answer: L.exitA }],
    homework: { description: L.hw(topic), minutes: 15 },
    links: [L.link(topic)],
    board_work: L.board(topic),
    reflection: '',
  };
}

export function mockGenerate(action: string, c: Ctx): unknown {
  switch (action) {
    case 'daily_plan':
      return dailyPlan(c);
    case 'section_rewrite': {
      const plan = dailyPlan(c) as Record<string, unknown>;
      const section = String(c.section ?? 'flow');
      const current = (c.current as Record<string, unknown>) ?? {};
      if (c.op === 'add_questions' && Array.isArray(current.questions)) return { value: [...(current.questions as unknown[]), ...(plan.questions as unknown[])] };
      if (c.op === 'add_unplugged_activity') return { value: [...((current.materials as string[]) ?? []), 'Paper cards for a no-device sorting activity'] };
      return { value: plan[section] ?? current[section] ?? null };
    }
    case 'companion': {
      const L = PHRASES[lang(c)];
      const topic = String(c.topic ?? 'the topic');
      const kind = String(c.kind ?? 'worksheet');
      const items = [1, 2, 3, 4, 5].map((n) => ({ question: `${n}. ${n % 2 ? L.q1(topic) : L.q2(topic)}`, answer: L.exitA }));
      return { title: `${kind.replace('_', ' ')}: ${topic}`, instructions: kind === 'cover_plan' ? 'Self-contained activity for a substitute teacher; no prior preparation needed.' : 'Answer all questions.', items };
    }
    case 'unit_plan': {
      const topics = (c.topics as string[]) ?? [String(c.topic ?? 'Topic')];
      return { objectives: topics.map((t) => `Understand ${t}`), periods: topics.map((t, k) => ({ period: k + 1, focus: t, activity: 'Explain, practise, check' })), assessments: ['Quiz after period 3', 'End-of-unit test'] };
    }
    case 'recovery_plan': {
      const remaining = (c.remaining as { topicId: string; name: string; periods: number }[]) ?? [];
      const available = Number(c.availablePeriods ?? 0);
      const need = remaining.reduce((s, r) => s + r.periods, 0);
      const ratio = need > 0 ? Math.min(1, available / need) : 1;
      return { summary: need > available ? `Remaining chapters need ${need} periods but only ${available} remain; compress by ${Math.round((1 - ratio) * 100)}%.` : 'Remaining chapters fit in the available periods.', chapters: remaining.map((r) => ({ topic_id: r.topicId, periods: Math.max(1, Math.floor(r.periods * ratio)), compress: r.periods * ratio < r.periods ? 'Combine practice into homework; teach core concepts in class' : '' })) };
    }
    case 'question_paper': {
      const slots = (c.slots as { no: number; questionType: string; marks: number; topicName: string; difficulty: string }[]) ?? [];
      return { questions: slots.map((s) => ({ no: s.no, text: `[${s.topicName}] ${s.questionType === 'mcq' || s.questionType === 'multiple_choice' ? 'Choose the correct option:' : 'Answer:'} ${s.difficulty} question for ${s.marks} mark(s).`, options: s.questionType === 'mcq' || s.questionType === 'multiple_choice' ? ['Option A', 'Option B', 'Option C', 'Option D'] : [], answer: s.questionType === 'mcq' || s.questionType === 'multiple_choice' ? 'Option A' : 'Model answer with key points', marking: [{ step: 'Correct method / key point', marks: s.marks }] })) };
    }
    case 'weekly_insight': {
      const facts = (c.facts as { text: string; link: string }[]) ?? [];
      return { improved: facts.slice(0, 2).map((f) => f.text), worsened: facts.slice(2, 4).map((f) => f.text), decisions: facts.slice(0, 5).map((f) => ({ text: f.text, link: f.link })) };
    }
    case 'ask_question': {
      const q = String(c.question ?? '').toLowerCase();
      if (q.includes('overdue')) return { function: 'overdue_tasks_by_person', params: {} };
      if (q.includes('leave')) return { function: 'leave_by_type', params: {} };
      if (q.includes('late') || q.includes('attendance')) return { function: 'late_staff', params: {} };
      if (q.includes('plan') || q.includes('lesson')) return { function: 'plan_compliance_by_teacher', params: {} };
      if (q.includes('ticket') || q.includes('repair')) return { function: 'open_tickets_by_category', params: {} };
      if (q.includes('coverage') || q.includes('syllabus') || q.includes('behind')) return { function: 'coverage_by_class', params: {} };
      return { function: 'none', params: {} };
    }
    case 'help_bot': {
      const snippets = (c.snippets as { title: string; body: string; screen: string | null }[]) ?? [];
      const top = snippets[0];
      if (!top) return { answerable: false, steps: [], screen: null };
      const steps = top.body
        .split('\n')
        .map((l) => l.replace(/^\s*(\d+\.|-)\s*/, '').trim())
        .filter((l) => l.length > 3 && !l.startsWith('#'))
        .slice(0, 6);
      return { answerable: true, steps, screen: top.screen };
    }
    case 'designer_plan':
      // AI school designer: deterministic plans for the standard requests (packages/shared/src/designer/mock.ts)
      return mockDesignerPlan(String(c.prompt ?? ''), {
        roles: (c.roles as string[]) ?? [],
        branch_code: String(c.branch_code ?? ''),
        products: (c.products as string[] | undefined) ?? undefined,
        product_roles: (c.product_roles as Record<string, string[]> | undefined) ?? undefined,
        record_roles: (c.record_roles as string[] | undefined) ?? undefined,
      });
    default:
      return {};
  }
}
