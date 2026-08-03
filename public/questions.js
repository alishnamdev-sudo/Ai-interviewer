// ─── Question Database ────────────────────────────────────────────────────────
// Each entry: { id, topic, question, difficulty, subject }
// Add more questions here or replace with an API call later.

const QUESTIONS_DB = {
  Mathematics: [
    {
      id: 'math_1',
      topic: 'Quadratic Equations',
      difficulty: 'Medium',
      subject: 'Mathematics',
      question: 'Find all real roots of 2x² − 5x + 2 = 0. Show your working.'
    },
    {
      id: 'math_2',
      topic: 'Trigonometry',
      difficulty: 'Medium',
      subject: 'Mathematics',
      question: 'Evaluate sin(45°) × cos(30°) + cos(45°) × sin(30°) without a calculator.'
    },
    {
      id: 'math_3',
      topic: 'Differential Calculus',
      difficulty: 'Medium',
      subject: 'Mathematics',
      question: 'Differentiate f(x) = x³ − 3x² + 2x − 5, then find all x where f\'(x) = 0.'
    },
    {
      id: 'math_4',
      topic: 'Arithmetic Progression',
      difficulty: 'Easy',
      subject: 'Mathematics',
      question: 'The 3rd term of an AP is 7 and its 7th term is 19. Find the sum of the first 20 terms.'
    }
  ],

  Physics: [
    {
      id: 'phy_1',
      topic: 'Kinematics',
      difficulty: 'Medium',
      subject: 'Physics',
      question: 'A ball is projected vertically upward at 20 m/s. Find the maximum height reached. [g = 10 m/s²]'
    },
    {
      id: 'phy_2',
      topic: 'DC Circuits',
      difficulty: 'Medium',
      subject: 'Physics',
      question: 'Three resistors — 4 Ω, 6 Ω, and 12 Ω — are connected in parallel across a 12 V battery. Find the equivalent resistance.'
    },
    {
      id: 'phy_3',
      topic: "Newton's Laws",
      difficulty: 'Medium',
      subject: 'Physics',
      question: 'A 5 kg block is placed on a frictionless incline at 30° to the horizontal. Find its acceleration. [g = 10 m/s²]'
    }
  ],

  Chemistry: [
    {
      id: 'chem_1',
      topic: 'Redox Reactions',
      difficulty: 'Medium',
      subject: 'Chemistry',
      question: 'Balance the equation Fe₂O₃ + CO → Fe + CO₂ and identify which species is reduced.'
    },
    {
      id: 'chem_2',
      topic: 'Mole Concept',
      difficulty: 'Medium',
      subject: 'Chemistry',
      question: 'Calculate the number of molecules in 18 g of water. [Avogadro\'s number = 6.022 × 10²³, molar mass of H₂O = 18 g/mol]'
    },
    {
      id: 'chem_3',
      topic: 'Periodic Trends',
      difficulty: 'Easy',
      subject: 'Chemistry',
      question: 'Arrange Na, Mg, Al, Si, P in order of increasing ionisation energy.'
    }
  ],

  Biology: [
    {
      id: 'bio_1',
      topic: 'Cell Division',
      difficulty: 'Medium',
      subject: 'Biology',
      question: 'Describe what happens to the chromosomes during each phase of mitosis.'
    },
    {
      id: 'bio_2',
      topic: 'Photosynthesis',
      difficulty: 'Medium',
      subject: 'Biology',
      question: 'Write the overall balanced equation for photosynthesis and state where the light-dependent reaction occurs.'
    }
  ],

  'Computer Science': [
    {
      id: 'cs_1',
      topic: 'Searching Algorithms',
      difficulty: 'Medium',
      subject: 'Computer Science',
      question: 'Write the step-by-step algorithm for Binary Search on a sorted array and state its worst-case time complexity.'
    },
    {
      id: 'cs_2',
      topic: 'Object-Oriented Programming',
      difficulty: 'Medium',
      subject: 'Computer Science',
      question: 'Explain the difference between compile-time and run-time polymorphism with a short example.'
    }
  ],

  English: [
    {
      id: 'eng_1',
      topic: 'Grammar & Error Correction',
      difficulty: 'Medium',
      subject: 'English',
      question: 'Correct the grammatical errors in: "Their was a time when people use to walk miles to get water."'
    },
    {
      id: 'eng_2',
      topic: 'Figurative Language',
      difficulty: 'Easy',
      subject: 'English',
      question: 'Identify the figure of speech in "He is as brave as a lion" and explain its effect.'
    }
  ]
};

/**
 * Returns a random question for the given subject.
 * Falls back to Mathematics if subject not found.
 * @param {string} subject
 * @returns {{ id, topic, difficulty, subject, question }}
 */
function getRandomQuestion(subject) {
  const pool = QUESTIONS_DB[subject] || QUESTIONS_DB['Mathematics'];
  return pool[Math.floor(Math.random() * pool.length)];
}
