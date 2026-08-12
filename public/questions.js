// ─── Question Database ────────────────────────────────────────────────────────
// Each entry: { id, topic, question, difficulty, subject, hasDiagram, diagramSvg }
// All entries are Medium difficulty by design (see getRandomQuestions, which
// also enforces this as a filter) — the 90-second whiteboard window suits
// medium-depth problems, not trivial recall or multi-step hard problems.
// Each subject includes at least one hasDiagram:true question, where the
// DIAGRAM ITSELF IS GIVEN as part of the question (rendered from diagramSvg)
// and the candidate must read/interpret it to answer — the solution is
// written/calculated normally, not a diagram the candidate has to draw.
// Add more questions here, or replace with an API call later.

const QUESTIONS_DB = {
  Mathematics: [
    {
      id: 'math_1',
      topic: 'Quadratic Equations',
      difficulty: 'Medium',
      subject: 'Mathematics',
      hasDiagram: false,
      question: 'Find all real roots of 2x² − 5x + 2 = 0. Show your working.'
    },
    {
      id: 'math_2',
      topic: 'Trigonometry',
      difficulty: 'Medium',
      subject: 'Mathematics',
      hasDiagram: false,
      question: 'Evaluate sin(45°) × cos(30°) + cos(45°) × sin(30°) without a calculator.'
    },
    {
      id: 'math_3',
      topic: 'Differential Calculus',
      difficulty: 'Medium',
      subject: 'Mathematics',
      hasDiagram: false,
      question: 'Differentiate f(x) = x³ − 3x² + 2x − 5, then find all x where f\'(x) = 0.'
    },
    {
      id: 'math_4',
      topic: 'Arithmetic Progression',
      difficulty: 'Medium',
      subject: 'Mathematics',
      hasDiagram: false,
      question: 'The 3rd term of an AP is 7 and its 7th term is 19. Find the sum of the first 20 terms.'
    },
    {
      id: 'math_5',
      topic: 'Right Triangles',
      difficulty: 'Medium',
      subject: 'Mathematics',
      hasDiagram: true,
      question: 'The diagram shows a right-angled triangle with the two legs measuring 6 cm and 8 cm. Using the diagram, find the length of the hypotenuse and the measure of the angle opposite the 6 cm side.',
      diagramSvg: '<svg viewBox="0 0 240 180" xmlns="http://www.w3.org/2000/svg"><polygon points="30,150 30,30 190,150" fill="none" stroke="#1a1a1a" stroke-width="2"/><rect x="30" y="138" width="12" height="12" fill="none" stroke="#1a1a1a" stroke-width="1.5"/><text x="6" y="95" font-size="14" fill="#1a1a1a">6 cm</text><text x="95" y="168" font-size="14" fill="#1a1a1a">8 cm</text><text x="118" y="82" font-size="14" fill="#1a1a1a">?</text></svg>',
      evalContext: 'Right triangle, legs 6 cm and 8 cm, right angle between them. Correct: hypotenuse = 10 cm (Pythagoras); angle opposite the 6 cm side = arcsin(6/10) ≈ 36.87°.'
    }
  ],

  Physics: [
    {
      id: 'phy_1',
      topic: 'Kinematics',
      difficulty: 'Medium',
      subject: 'Physics',
      hasDiagram: false,
      question: 'A ball is projected vertically upward at 20 m/s. Find the maximum height reached. [g = 10 m/s²]'
    },
    {
      id: 'phy_2',
      topic: 'DC Circuits',
      difficulty: 'Medium',
      subject: 'Physics',
      hasDiagram: true,
      question: 'The circuit diagram shows three resistors — 4 Ω, 6 Ω, and 12 Ω — connected in parallel across a 12 V battery. Using the diagram, find the equivalent resistance and the total current drawn from the battery.',
      diagramSvg: '<svg viewBox="0 0 320 160" xmlns="http://www.w3.org/2000/svg"><line x1="40" y1="20" x2="280" y2="20" stroke="#1a1a1a" stroke-width="2"/><line x1="40" y1="140" x2="280" y2="140" stroke="#1a1a1a" stroke-width="2"/><line x1="40" y1="20" x2="40" y2="60" stroke="#1a1a1a" stroke-width="2"/><line x1="30" y1="60" x2="50" y2="60" stroke="#1a1a1a" stroke-width="3"/><line x1="35" y1="70" x2="45" y2="70" stroke="#1a1a1a" stroke-width="3"/><line x1="40" y1="70" x2="40" y2="140" stroke="#1a1a1a" stroke-width="2"/><text x="6" y="65" font-size="12" fill="#1a1a1a">12V</text><g stroke="#1a1a1a" stroke-width="2" fill="none"><path d="M100,20 L100,45 L110,50 L90,58 L110,66 L90,74 L100,80 L100,140"/><path d="M170,20 L170,45 L180,50 L160,58 L180,66 L160,74 L170,80 L170,140"/><path d="M240,20 L240,45 L250,50 L230,58 L250,66 L230,74 L240,80 L240,140"/></g><text x="78" y="97" font-size="12" fill="#1a1a1a">4Ω</text><text x="148" y="97" font-size="12" fill="#1a1a1a">6Ω</text><text x="215" y="97" font-size="12" fill="#1a1a1a">12Ω</text></svg>',
      evalContext: '4Ω, 6Ω, 12Ω resistors in parallel across a 12V battery. Correct: 1/Req = 1/4+1/6+1/12 = 1/2, so Req = 2Ω; total current I = V/Req = 12/2 = 6A.'
    },
    {
      id: 'phy_3',
      topic: "Newton's Laws",
      difficulty: 'Medium',
      subject: 'Physics',
      hasDiagram: false,
      question: 'A 5 kg block is placed on a frictionless incline at 30° to the horizontal. Find its acceleration. [g = 10 m/s²]'
    }
  ],

  Chemistry: [
    {
      id: 'chem_1',
      topic: 'Redox Reactions',
      difficulty: 'Medium',
      subject: 'Chemistry',
      hasDiagram: false,
      question: 'Balance the equation Fe₂O₃ + CO → Fe + CO₂ and identify which species is reduced.'
    },
    {
      id: 'chem_2',
      topic: 'Mole Concept',
      difficulty: 'Medium',
      subject: 'Chemistry',
      hasDiagram: false,
      question: 'Calculate the number of molecules in 18 g of water. [Avogadro\'s number = 6.022 × 10²³, molar mass of H₂O = 18 g/mol]'
    },
    {
      id: 'chem_3',
      topic: 'Periodic Trends',
      difficulty: 'Medium',
      subject: 'Chemistry',
      hasDiagram: false,
      question: 'Arrange Na, Mg, Al, Si, P in order of increasing ionisation energy, and explain the exceptions to the general trend.'
    },
    {
      id: 'chem_4',
      topic: 'Atomic Structure',
      difficulty: 'Medium',
      subject: 'Chemistry',
      hasDiagram: true,
      question: 'The diagram shows the atomic structure of an element with a nuclear charge of +11 and electron shells containing 2, 8, and 1 electrons respectively. Identify the element, write its full electronic configuration, and state which group of the periodic table it belongs to.',
      diagramSvg: '<svg viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg"><circle cx="110" cy="110" r="12" fill="#1a1a1a"/><text x="110" y="114" font-size="10" fill="#fff" text-anchor="middle">+11</text><circle cx="110" cy="110" r="35" fill="none" stroke="#2563eb" stroke-width="1.5"/><circle cx="110" cy="110" r="60" fill="none" stroke="#2563eb" stroke-width="1.5"/><circle cx="110" cy="110" r="85" fill="none" stroke="#2563eb" stroke-width="1.5"/><text x="110" y="80" font-size="13" fill="#1a1a1a" text-anchor="middle">2e⁻</text><text x="110" y="53" font-size="13" fill="#1a1a1a" text-anchor="middle">8e⁻</text><text x="110" y="28" font-size="13" fill="#1a1a1a" text-anchor="middle">1e⁻</text></svg>',
      evalContext: 'Nuclear charge +11, shells 2,8,1 → element is Sodium (Na). Correct electronic configuration: 1s² 2s² 2p⁶ 3s¹ (or 2,8,1 shorthand). Belongs to Group 1 (alkali metals).'
    }
  ],

  Biology: [
    {
      id: 'bio_1',
      topic: 'Cell Division',
      difficulty: 'Medium',
      subject: 'Biology',
      hasDiagram: false,
      question: 'Describe what happens to the chromosomes during each phase of mitosis.'
    },
    {
      id: 'bio_2',
      topic: 'Photosynthesis',
      difficulty: 'Medium',
      subject: 'Biology',
      hasDiagram: false,
      question: 'Write the overall balanced equation for photosynthesis and state where the light-dependent reaction occurs.'
    },
    {
      id: 'bio_3',
      topic: 'Cell Structure',
      difficulty: 'Medium',
      subject: 'Biology',
      hasDiagram: true,
      question: 'The diagram shows a plant cell with structures labelled A, B, and C. Identify structures A, B, and C, and state one function of structure C.',
      diagramSvg: '<svg viewBox="0 0 260 180" xmlns="http://www.w3.org/2000/svg"><rect x="15" y="15" width="230" height="150" rx="20" fill="none" stroke="#1a1a1a" stroke-width="2"/><ellipse cx="180" cy="90" rx="55" ry="45" fill="none" stroke="#16a34a" stroke-width="1.5"/><text x="180" y="94" font-size="12" fill="#16a34a" text-anchor="middle">B</text><circle cx="80" cy="60" r="22" fill="none" stroke="#7c3aed" stroke-width="1.5"/><text x="80" y="64" font-size="12" fill="#7c3aed" text-anchor="middle">A</text><ellipse cx="70" cy="125" rx="15" ry="9" fill="none" stroke="#16a34a" stroke-width="1.5"/><text x="70" y="128" font-size="11" fill="#16a34a" text-anchor="middle">C</text><ellipse cx="108" cy="135" rx="15" ry="9" fill="none" stroke="#16a34a" stroke-width="1.5"/><text x="108" y="138" font-size="11" fill="#16a34a" text-anchor="middle">C</text></svg>',
      evalContext: 'Plant cell diagram: outer rounded rectangle = cell wall. A = small circle near top-left = nucleus. B = large oval taking up most of the cell = vacuole. C = two small oval structures near the bottom = chloroplasts. Function of chloroplast: site of photosynthesis, converts light energy into chemical energy (glucose).'
    }
  ],

  'Computer Science': [
    {
      id: 'cs_1',
      topic: 'Searching Algorithms',
      difficulty: 'Medium',
      subject: 'Computer Science',
      hasDiagram: false,
      question: 'Write the step-by-step algorithm for Binary Search on a sorted array and state its worst-case time complexity.'
    },
    {
      id: 'cs_2',
      topic: 'Object-Oriented Programming',
      difficulty: 'Medium',
      subject: 'Computer Science',
      hasDiagram: false,
      question: 'Explain the difference between compile-time and run-time polymorphism with a short example.'
    },
    {
      id: 'cs_3',
      topic: 'Data Structures',
      difficulty: 'Medium',
      subject: 'Computer Science',
      hasDiagram: false,
      question: 'Explain how a stack can be used to check whether a string of parentheses is balanced, with a short trace-through example.'
    },
    {
      id: 'cs_4',
      topic: 'Flowcharts & Algorithms',
      difficulty: 'Medium',
      subject: 'Computer Science',
      hasDiagram: true,
      question: 'The flowchart shows an algorithm for a given input N. Trace through it for N = 5, state the final value that gets printed, and explain in one line what the flowchart computes in general.',
      diagramSvg: '<svg viewBox="0 0 220 340" xmlns="http://www.w3.org/2000/svg"><ellipse cx="110" cy="25" rx="45" ry="18" fill="none" stroke="#1a1a1a" stroke-width="1.5"/><text x="110" y="29" font-size="11" text-anchor="middle" fill="#1a1a1a">Start</text><line x1="110" y1="43" x2="110" y2="63" stroke="#1a1a1a" stroke-width="1.5"/><rect x="45" y="63" width="130" height="34" fill="none" stroke="#1a1a1a" stroke-width="1.5"/><text x="110" y="84" font-size="11" text-anchor="middle" fill="#1a1a1a">sum = 0, i = 1</text><line x1="110" y1="97" x2="110" y2="118" stroke="#1a1a1a" stroke-width="1.5"/><polygon points="110,118 162,150 110,182 58,150" fill="none" stroke="#1a1a1a" stroke-width="1.5"/><text x="110" y="154" font-size="11" text-anchor="middle" fill="#1a1a1a">i ≤ N ?</text><line x1="110" y1="182" x2="110" y2="203" stroke="#1a1a1a" stroke-width="1.5"/><text x="120" y="199" font-size="10" fill="#1a1a1a">Yes</text><rect x="30" y="203" width="160" height="34" fill="none" stroke="#1a1a1a" stroke-width="1.5"/><text x="110" y="224" font-size="11" text-anchor="middle" fill="#1a1a1a">sum += i, i += 1</text><path d="M30,220 H10 V150 H58" fill="none" stroke="#1a1a1a" stroke-width="1.5"/><text x="172" y="145" font-size="10" fill="#1a1a1a">No</text><line x1="162" y1="150" x2="200" y2="150" stroke="#1a1a1a" stroke-width="1.5"/><line x1="200" y1="150" x2="200" y2="277" stroke="#1a1a1a" stroke-width="1.5"/><line x1="200" y1="277" x2="175" y2="277" stroke="#1a1a1a" stroke-width="1.5"/><rect x="45" y="260" width="130" height="34" fill="none" stroke="#1a1a1a" stroke-width="1.5"/><text x="110" y="281" font-size="11" text-anchor="middle" fill="#1a1a1a">Print sum</text><line x1="110" y1="294" x2="110" y2="315" stroke="#1a1a1a" stroke-width="1.5"/><ellipse cx="110" cy="322" rx="40" ry="17" fill="none" stroke="#1a1a1a" stroke-width="1.5"/><text x="110" y="326" font-size="11" text-anchor="middle" fill="#1a1a1a">End</text></svg>',
      evalContext: 'Flowchart: sum=0, i=1; while i<=N: sum+=i, i+=1; then print sum. It computes the sum of integers from 1 to N. For N=5, correct final printed value = 15 (1+2+3+4+5).'
    }
  ],

  English: [
    {
      id: 'eng_1',
      topic: 'Grammar & Error Correction',
      difficulty: 'Medium',
      subject: 'English',
      hasDiagram: false,
      question: 'Correct the grammatical errors in: "Their was a time when people use to walk miles to get water."'
    },
    {
      id: 'eng_2',
      topic: 'Figurative Language',
      difficulty: 'Medium',
      subject: 'English',
      hasDiagram: true,
      question: 'The Venn diagram compares similes and metaphors, with one distinguishing feature shown in each circle. Based on the diagram, explain what belongs in the overlapping middle section, and give one original example each of a simile and a metaphor.',
      diagramSvg: '<svg viewBox="0 0 300 180" xmlns="http://www.w3.org/2000/svg"><circle cx="110" cy="90" r="75" fill="none" stroke="#2563eb" stroke-width="1.5"/><circle cx="190" cy="90" r="75" fill="none" stroke="#dc2626" stroke-width="1.5"/><text x="65" y="35" font-size="13" fill="#2563eb" text-anchor="middle">Simile</text><text x="235" y="35" font-size="13" fill="#dc2626" text-anchor="middle">Metaphor</text><text x="55" y="95" font-size="10" fill="#1a1a1a" text-anchor="middle">uses "like"</text><text x="55" y="108" font-size="10" fill="#1a1a1a" text-anchor="middle">or "as"</text><text x="245" y="95" font-size="10" fill="#1a1a1a" text-anchor="middle">direct</text><text x="245" y="108" font-size="10" fill="#1a1a1a" text-anchor="middle">comparison</text><text x="150" y="98" font-size="14" fill="#1a1a1a" text-anchor="middle" font-style="italic">?</text></svg>',
      evalContext: 'Venn diagram: Simile circle = uses "like"/"as"; Metaphor circle = direct comparison without "like"/"as". Overlap should be: both are figures of speech that compare two unlike things for effect.'
    },
    {
      id: 'eng_3',
      topic: 'Comprehension & Tone',
      difficulty: 'Medium',
      subject: 'English',
      hasDiagram: false,
      question: 'Read the line "The old house stood silent, its windows like tired eyes." Identify the literary device used and explain the mood it creates.'
    }
  ]
};

/**
 * Returns a random question for the given subject.
 * Falls back to Mathematics if subject not found.
 * @param {string} subject
 * @returns {{ id, topic, difficulty, subject, hasDiagram, diagramSvg, question }}
 */
function getRandomQuestion(subject) {
  const pool = QUESTIONS_DB[subject] || QUESTIONS_DB['Mathematics'];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Returns up to `count` distinct random Medium-difficulty questions for the
 * given subject (no repeats within the batch) — never mixes in another
 * subject's questions. Falls back to Mathematics if subject not found; if a
 * subject's Medium-difficulty pool has fewer than `count` questions, returns
 * all of them (falling back to that subject's full pool only if it somehow
 * has no Medium questions at all).
 * @param {string} subject
 * @param {number} count
 * @returns {Array<{ id, topic, difficulty, subject, hasDiagram, diagramSvg, question }>}
 */
function getRandomQuestions(subject, count) {
  const fullPool = QUESTIONS_DB[subject] || QUESTIONS_DB['Mathematics'];
  const mediumPool = fullPool.filter(q => q.difficulty === 'Medium');
  const pool = (mediumPool.length ? mediumPool : fullPool).slice();

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}
