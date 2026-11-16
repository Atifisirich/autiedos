/**
 * Preloaded curriculum maps (PRD 6.1 Curriculum library). Outlines written for AutoEd and
 * tagged with the syllabus year: chapter and topic names with short learning outcomes.
 * No textbook or board text is copied. Every year these need a subject expert's review
 * before schools rely on them (open item in PRD 10.3).
 *
 * Coverage in this release: CBSE Classes 9–10 Science and Mathematics, CBSE Class 8 Hindi,
 * Cambridge Lower Secondary Science Stage 8 and Cambridge IGCSE Mathematics. Further grades
 * load through the super admin curriculum screen in the same format.
 */
export interface OutlineTopic {
  name: string;
  outcomes: string[];
  competency?: string;
}
export interface OutlineChapter {
  name: string;
  periods: number;
  weight?: number;
  topics?: OutlineTopic[];
}
export interface OutlineUnit {
  name: string;
  chapters: OutlineChapter[];
}
export interface OutlineSubject {
  stage: string;
  grade: number;
  name: string;
  code: string;
  language: 'en' | 'hi' | 'te';
  units: OutlineUnit[];
}
export interface OutlineBoard {
  key: 'CBSE' | 'CAMBRIDGE';
  name: string;
  syllabusYear: string;
  subjects: OutlineSubject[];
}

const ch = (name: string, periods: number, topics?: OutlineTopic[]): OutlineChapter => ({ name, periods, topics });

export const CURRICULUM: OutlineBoard[] = [
  {
    key: 'CBSE',
    name: 'CBSE',
    syllabusYear: '2026-27',
    subjects: [
      {
        stage: 'Class 10', grade: 10, name: 'Science', code: 'SCI', language: 'en',
        units: [
          { name: 'Chemical substances – nature and behaviour', chapters: [
            ch('Chemical Reactions and Equations', 10, [
              { name: 'Writing and balancing chemical equations', outcomes: ['Write balanced chemical equations from word descriptions', 'Explain the law of conservation of mass using balanced equations'], competency: 'Represents changes symbolically' },
              { name: 'Types of chemical reactions', outcomes: ['Classify reactions as combination, decomposition, displacement, double displacement', 'Identify exothermic and endothermic reactions from observations'] },
              { name: 'Oxidation and reduction in daily life', outcomes: ['Identify oxidation and reduction in a given reaction', 'Explain corrosion and rancidity with everyday examples'] },
            ]),
            ch('Acids, Bases and Salts', 12, [
              { name: 'Properties of acids and bases', outcomes: ['Describe reactions of acids and bases with metals, carbonates and each other', 'Use indicators to identify acids and bases'] },
              { name: 'pH and its importance', outcomes: ['Interpret the pH scale', 'Relate pH to digestion, tooth decay and soil'] },
              { name: 'Salts of everyday use', outcomes: ['Explain the preparation and uses of common salts such as baking soda and bleaching powder'] },
            ]),
            ch('Metals and Non-metals', 10),
            ch('Carbon and its Compounds', 12),
          ] },
          { name: 'World of living', chapters: [
            ch('Life Processes', 14, [
              { name: 'Nutrition in plants – photosynthesis', outcomes: ['Explain photosynthesis as conversion of light energy to chemical energy', 'Design a simple test to show that light and chlorophyll are needed'], competency: 'Plans investigations' },
              { name: 'Respiration', outcomes: ['Compare aerobic and anaerobic respiration', 'Describe the role of the human respiratory system'] },
              { name: 'Transportation and excretion', outcomes: ['Describe the double circulation of blood in humans', 'Explain how kidneys filter blood'] },
            ]),
            ch('Control and Coordination', 10),
            ch('How do Organisms Reproduce?', 10),
            ch('Heredity', 8),
          ] },
          { name: 'Natural phenomena', chapters: [ch('Light – Reflection and Refraction', 14), ch('The Human Eye and the Colourful World', 8)] },
          { name: 'Effects of current', chapters: [ch('Electricity', 14), ch('Magnetic Effects of Electric Current', 10)] },
          { name: 'Natural resources', chapters: [ch('Our Environment', 6)] },
        ],
      },
      {
        stage: 'Class 10', grade: 10, name: 'Mathematics', code: 'MAT', language: 'en',
        units: [
          { name: 'Number systems', chapters: [ch('Real Numbers', 10)] },
          { name: 'Algebra', chapters: [ch('Polynomials', 10), ch('Pair of Linear Equations in Two Variables', 14), ch('Quadratic Equations', 14, [
            { name: 'Standard form and roots', outcomes: ['Identify quadratic equations and write them in standard form', 'Find roots by factorisation'] },
            { name: 'Quadratic formula and discriminant', outcomes: ['Solve quadratic equations using the quadratic formula', 'Use the discriminant to decide the nature of roots'] },
            { name: 'Word problems', outcomes: ['Model real-life situations with quadratic equations and solve them'], competency: 'Applies algebra to real contexts' },
          ]), ch('Arithmetic Progressions', 12)] },
          { name: 'Coordinate geometry', chapters: [ch('Coordinate Geometry', 10)] },
          { name: 'Geometry', chapters: [ch('Triangles', 14), ch('Circles', 8)] },
          { name: 'Trigonometry', chapters: [ch('Introduction to Trigonometry', 14), ch('Some Applications of Trigonometry', 8)] },
          { name: 'Mensuration', chapters: [ch('Areas Related to Circles', 8), ch('Surface Areas and Volumes', 12)] },
          { name: 'Statistics and probability', chapters: [ch('Statistics', 12), ch('Probability', 8)] },
        ],
      },
      {
        stage: 'Class 9', grade: 9, name: 'Science', code: 'SCI', language: 'en',
        units: [
          { name: 'Matter – its nature and behaviour', chapters: [ch('Matter in Our Surroundings', 10), ch('Is Matter Around Us Pure?', 12), ch('Atoms and Molecules', 12), ch('Structure of the Atom', 10)] },
          { name: 'Organisation in the living world', chapters: [ch('The Fundamental Unit of Life', 10), ch('Tissues', 10)] },
          { name: 'Motion, force and work', chapters: [ch('Motion', 12), ch('Force and Laws of Motion', 12), ch('Gravitation', 12), ch('Work and Energy', 10), ch('Sound', 10)] },
          { name: 'Food', chapters: [ch('Improvement in Food Resources', 8)] },
        ],
      },
      {
        stage: 'Class 9', grade: 9, name: 'Mathematics', code: 'MAT', language: 'en',
        units: [
          { name: 'Number systems', chapters: [ch('Number Systems', 12)] },
          { name: 'Algebra', chapters: [ch('Polynomials', 12), ch('Linear Equations in Two Variables', 10)] },
          { name: 'Coordinate geometry', chapters: [ch('Coordinate Geometry', 8)] },
          { name: 'Geometry', chapters: [ch("Introduction to Euclid's Geometry", 6), ch('Lines and Angles', 10), ch('Triangles', 12), ch('Quadrilaterals', 10), ch('Circles', 10)] },
          { name: 'Mensuration', chapters: [ch("Heron's Formula", 6), ch('Surface Areas and Volumes', 12)] },
          { name: 'Statistics', chapters: [ch('Statistics', 10)] },
        ],
      },
      {
        stage: 'Class 8', grade: 8, name: 'हिन्दी', code: 'HIN', language: 'hi',
        units: [
          { name: 'व्याकरण', chapters: [
            ch('संज्ञा और सर्वनाम', 6, [
              { name: 'संज्ञा के भेद', outcomes: ['व्यक्तिवाचक, जातिवाचक और भाववाचक संज्ञा पहचानना', 'वाक्यों में संज्ञा शब्दों का सही प्रयोग करना'] },
              { name: 'सर्वनाम के भेद', outcomes: ['पुरुषवाचक, निजवाचक और संबंधवाचक सर्वनाम पहचानना'] },
            ]),
            ch('विशेषण और क्रिया', 6, [
              { name: 'विशेषण के भेद', outcomes: ['गुणवाचक, संख्यावाचक और परिमाणवाचक विशेषण पहचानना'] },
              { name: 'सकर्मक और अकर्मक क्रिया', outcomes: ['सकर्मक और अकर्मक क्रिया में अंतर बताना'] },
            ]),
            ch('काल', 5),
          ] },
          { name: 'लेखन', chapters: [ch('पत्र लेखन', 5), ch('निबंध लेखन', 6), ch('अनुच्छेद लेखन', 4)] },
          { name: 'पठन', chapters: [ch('गद्य पाठ – पठन और समझ', 12), ch('काव्य पाठ – पठन और समझ', 10)] },
        ],
      },
    ],
  },
  {
    key: 'CAMBRIDGE',
    name: 'Cambridge',
    syllabusYear: '2026',
    subjects: [
      {
        stage: 'Lower Secondary Stage 8', grade: 8, name: 'Science', code: 'SCI', language: 'en',
        units: [
          { name: 'Biology', chapters: [
            ch('Respiration', 8, [
              { name: 'Aerobic respiration and gas exchange', outcomes: ['Describe aerobic respiration with a word equation', 'Explain how the structure of alveoli supports gas exchange'], competency: 'Thinking and working scientifically: models' },
              { name: 'Effects of exercise and smoking', outcomes: ['Plan an investigation into the effect of exercise on breathing rate', 'Describe the effects of smoking on the respiratory system'] },
            ]),
            ch('Diet and growth', 8),
            ch('Ecosystems', 8),
          ] },
          { name: 'Chemistry', chapters: [ch('Properties of materials', 8), ch('Chemical reactions', 10), ch('Rates of reaction', 8)] },
          { name: 'Physics', chapters: [ch('Forces and energy', 10), ch('Electricity', 10), ch('Light and sound', 8)] },
          { name: 'Earth and space', chapters: [ch('Climate and weather', 6)] },
        ],
      },
      {
        stage: 'IGCSE', grade: 10, name: 'Mathematics', code: 'MAT', language: 'en',
        units: [
          { name: 'Number', chapters: [ch('Number types, fractions and percentages', 14), ch('Ratio, proportion and rates', 8)] },
          { name: 'Algebra and graphs', chapters: [ch('Algebraic manipulation', 12), ch('Equations and inequalities', 12), ch('Sequences', 6), ch('Functions and graphs', 12)] },
          { name: 'Coordinate geometry', chapters: [ch('Straight-line graphs', 8)] },
          { name: 'Geometry', chapters: [ch('Geometrical terms, constructions and circle theorems', 12)] },
          { name: 'Mensuration', chapters: [ch('Perimeter, area and volume', 10)] },
          { name: 'Trigonometry', chapters: [ch('Right-angled and non-right-angled triangles', 12)] },
          { name: 'Transformations and vectors', chapters: [ch('Transformations and vectors', 8)] },
          { name: 'Probability and statistics', chapters: [ch('Probability', 8), ch('Statistics', 8)] },
        ],
      },
    ],
  },
];

/** Topics for a chapter: explicit ones, or a standard two-topic outline. */
export function chapterTopics(c: OutlineChapter, language: 'en' | 'hi' | 'te'): OutlineTopic[] {
  if (c.topics?.length) return c.topics;
  if (language === 'hi')
    return [
      { name: `${c.name} – मुख्य अवधारणाएँ`, outcomes: [`${c.name} की मुख्य अवधारणाओं को अपने शब्दों में समझाना`] },
      { name: `${c.name} – अभ्यास और प्रयोग`, outcomes: [`${c.name} से जुड़े प्रश्न हल करना और दैनिक जीवन से जोड़ना`] },
    ];
  return [
    { name: `${c.name}: key concepts`, outcomes: [`Explain the key concepts of ${c.name} in their own words`, `Use correct vocabulary for ${c.name}`] },
    { name: `${c.name}: practice and application`, outcomes: [`Solve problems on ${c.name}`, `Connect ${c.name} to everyday Indian contexts`] },
  ];
}
