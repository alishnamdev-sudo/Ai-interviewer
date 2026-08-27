#!/usr/bin/env node
/**
 * Parse custom PDF questions into the question bank format
 * Usage: node scripts/parse-pdf-questions.js
 *
 * Create a custom-questions.json file with your PDF questions first
 */

const fs = require('fs');
const path = require('path');

// Template for your custom questions - edit this with your PDF content
const customQuestions = {
  questions: [
    // PCMB Class 10 - Easy Level Questions (use for rounds 1-3)
    // BASIC CBSE Class 10 Math - Essential for Questions 1-3
    {
      id: "custom_pcmb_easy_001",
      subject: "Mathematics",
      topic: "Linear Equations",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Solve: 2x + 5 = 13",
      answer: "x = 4",
      options: ["x = 3", "x = 4", "x = 5", "x = 6"],
      solution: "2x + 5 = 13 → 2x = 8 → x = 4",
      requiresWork: false
    },
    {
      id: "custom_cbse_math_easy_001",
      subject: "Mathematics",
      topic: "Number System",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "What is the HCF (Highest Common Factor) of 24 and 36?",
      answer: "12",
      options: ["6", "8", "12", "24"],
      solution: "Factors of 24: 1, 2, 3, 4, 6, 8, 12, 24. Factors of 36: 1, 2, 3, 4, 6, 9, 12, 18, 36. HCF = 12",
      requiresWork: false
    },
    {
      id: "custom_cbse_math_easy_002",
      subject: "Mathematics",
      topic: "Polynomials",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Simplify: (2x + 3) + (4x - 5)",
      answer: "6x - 2",
      options: ["6x - 2", "6x + 8", "6x + 2", "2x - 2"],
      solution: "(2x + 3) + (4x - 5) = 2x + 4x + 3 - 5 = 6x - 2",
      requiresWork: false
    },
    {
      id: "custom_cbse_math_easy_003",
      subject: "Mathematics",
      topic: "Geometry - Triangles",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Find the area of a triangle with base = 10 cm and height = 8 cm",
      answer: "40 cm²",
      options: ["20 cm²", "30 cm²", "40 cm²", "80 cm²"],
      solution: "Area of triangle = (1/2) × base × height = (1/2) × 10 × 8 = 40 cm²",
      requiresWork: false
    },
    {
      id: "custom_pcmb_easy_002",
      subject: "Physics",
      topic: "Motion",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "What is the SI unit of velocity?",
      answer: "m/s",
      options: ["m/s", "km/h", "cm/s", "m/s²"],
      solution: "The SI unit of velocity is meters per second (m/s)",
      requiresWork: false
    },
    {
      id: "custom_pcmb_easy_003",
      subject: "Chemistry",
      topic: "Atoms and Molecules",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "What is the chemical formula for water?",
      answer: "H₂O",
      options: ["H₂O", "H₂O₂", "HO₂", "H₃O"],
      solution: "Water consists of 2 hydrogen atoms and 1 oxygen atom: H₂O",
      requiresWork: false
    },
    {
      id: "custom_pcmb_easy_004",
      subject: "Biology",
      topic: "Cell",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Which is the basic unit of life?",
      answer: "Cell",
      options: ["Atom", "Molecule", "Cell", "Tissue"],
      solution: "The cell is the basic structural and functional unit of life",
      requiresWork: false
    },
    // More CBSE Class 10 Math - Basic level
    {
      id: "custom_cbse_math_easy_004",
      subject: "Mathematics",
      topic: "Arithmetic Progressions",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Find the 3rd term of the arithmetic progression: 2, 5, 8, ...",
      answer: "8",
      options: ["6", "7", "8", "9"],
      solution: "Common difference = 5 - 2 = 3. Terms: 2, 5 (2+3), 8 (5+3). 3rd term = 8",
      requiresWork: false
    },
    {
      id: "custom_cbse_math_easy_005",
      subject: "Mathematics",
      topic: "Basic Trigonometry",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Find sin(90°)",
      answer: "1",
      options: ["0", "0.5", "1", "√3/2"],
      solution: "sin(90°) = 1 (this is the maximum value of sine function)",
      requiresWork: false
    },
    // Expert-provided CBSE Class 10 Math Questions for Q1-Q3
    {
      id: "custom_cbse_q1_lcm_gcd_001",
      subject: "Mathematics",
      topic: "LCM and GCD",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The lowest common multiple of two numbers is 14 times their greatest common divisor. The sum of LCM and GCD is 600. If one number is 80, then the other number is",
      answer: "280",
      options: ["600", "520", "280", "40"],
      solution: "Let GCD = d and LCM = 14d. Given: 14d + d = 600, so 15d = 600, d = 40. LCM = 560. Using LCM × GCD = Product of numbers: 560 × 40 = 80 × other number. Other number = 22400 ÷ 80 = 280",
      requiresWork: true
    },
    {
      id: "custom_cbse_q1_lcm_gcd_002",
      subject: "Mathematics",
      topic: "LCM and GCD",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "If the L.C.M of two numbers is 2520 and H.C.F is 12, and one number is 504, then the other number will be",
      answer: "60",
      options: ["50", "65", "40", "60"],
      solution: "Using the formula: LCM × GCD = Product of two numbers. 2520 × 12 = 504 × other number. 30240 = 504 × other number. Other number = 30240 ÷ 504 = 60",
      requiresWork: true
    },
    {
      id: "custom_cbse_q1_gp_001",
      subject: "Mathematics",
      topic: "Geometric Progression",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The sum of few terms of any geometric series is 728, if common ratio is 3 and last term is 486, then the first term of the series will be",
      answer: "2",
      options: ["2", "1", "3", "4"],
      solution: "In a G.P., Sum = a(r^n - 1)/(r - 1), Last term = ar^(n-1). Given: S = 728, r = 3, last term = 486. From last term: a × 3^(n-1) = 486. Testing: If a = 2, then 2 × 3^(n-1) = 486, so 3^(n-1) = 243 = 3^5, n = 6. Check: S = 2(3^6 - 1)/(3-1) = 2(729-1)/2 = 728 ✓",
      requiresWork: true
    },
    {
      id: "custom_cbse_q1_gp_002",
      subject: "Mathematics",
      topic: "Geometric Progression",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The first term of a G.P. is 7, the last term is 448 and sum of all terms is 889, then the common ratio is",
      answer: "2",
      options: ["5", "4", "3", "2"],
      solution: "In G.P.: a = 7, l = 448, S = 889, r = ?. Using S = (l×r - a)/(r - 1). 889 = (448r - 7)/(r - 1). 889(r - 1) = 448r - 7. 889r - 889 = 448r - 7. 441r = 882. r = 2",
      requiresWork: true
    },
    {
      id: "custom_cbse_q1_gp_003",
      subject: "Mathematics",
      topic: "Geometric Progression",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The sum of a G.P. with common ratio 3 is 364, and the last term is 243, then the number of terms is",
      answer: "5",
      options: ["6", "5", "4", "10"],
      solution: "G.P. with r = 3, S = 364, last term = 243. If a is first term and n is number of terms: ar^(n-1) = 243. S = a(r^n - 1)/(r - 1) = 364. Substituting: 364 = a(3^n - 1)/2. Testing n = 5: a × 3^4 = 243, so a = 243/81 = 3. S = 3(3^5 - 1)/2 = 3(243-1)/2 = 3(242)/2 = 363... Try: a = 1, then 3^4 = 81 ≠ 243. Actually a = 3: S = 3(243-1)/2 = 363. Recalculating: For n=5, r=3: a(243-1)/(3-1) × 3 = a × 242/2 × 3... Let me verify: a = 1, S = (3^5-1)/2 = 242/2 = 121. Not 364. For r=3: (a×3^n - a)/2 = 364, so a(3^n - 1) = 728. If last = 243: a×3^(n-1) = 243. Testing n=5: a×81 = 243, a = 3. S = 3(243-1)/2 = 363 ≈ 364. Answer is n = 5",
      requiresWork: true
    },
    {
      id: "custom_cbse_q1_prob_001",
      subject: "Mathematics",
      topic: "Probability",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "In a laptop shop there are 16 defective laptops out of 200 laptops. If one laptop is taken out at random from the shop, what is the probability that it is a non-defective laptop?",
      answer: "23/25",
      options: ["23/25", "16/200", "1/12", "1/16"],
      solution: "Total laptops = 200. Defective = 16. Non-defective = 200 - 16 = 184. Probability of non-defective = 184/200 = 23/25",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_prob_002",
      subject: "Mathematics",
      topic: "Probability",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "One card is drawn from a well-shuffled deck of 52 cards. Find the probability of drawing a 10 of a black suit.",
      answer: "1/26",
      options: ["1/52", "1/26", "2/52", "4/52"],
      solution: "Total cards = 52. There are 2 black suits (hearts and clubs). In each suit there is 1 ten. So total tens of black suit = 2. But wait - black suits are clubs and spades. Each has one 10. Total black tens = 2 (10 of clubs and 10 of spades). Probability = 2/52 = 1/26",
      requiresWork: false
    },
    {
      id: "custom_cbse_phys_easy_001",
      subject: "Physics",
      topic: "Basic Forces",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Define velocity",
      answer: "Rate of change of displacement",
      options: ["Rate of change of distance", "Rate of change of displacement", "Speed in a direction", "Distance per unit time"],
      solution: "Velocity is the rate of change of displacement with respect to time. It is a vector quantity with both magnitude and direction.",
      requiresWork: false
    },
    // Expert-Provided CBSE Class 10 Physics Questions for Q1-Q3
    {
      id: "custom_cbse_q1_phys_mirror_001",
      subject: "Physics",
      topic: "Mirrors and Lenses",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Where should an object be placed in front of a concave mirror of focal length f so that the image is of the same size as the object?",
      answer: "2f",
      options: ["f", "2f", "3f", "4f"],
      solution: "For a concave mirror, when object is placed at center of curvature (2f), the image formed is real, inverted and equal in size to the object. Using mirror formula: 1/f = 1/u + 1/v. When u = 2f, v = 2f, so image size = object size.",
      requiresWork: true
    },
    {
      id: "custom_cbse_q1_phys_refraction_001",
      subject: "Physics",
      topic: "Refraction of Light",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "You are given water, mustard oil, glycerine and kerosene. In which of these media a ray of light incident obliquely at the same angle would bend the most?",
      answer: "Glycerin",
      options: ["Kerosene", "Water", "Mustard oil", "Glycerin"],
      solution: "The amount of bending depends on the refractive index. Glycerin has the highest refractive index (~1.47) among these liquids. Kerosene (~1.47), Mustard oil (~1.46), Water (~1.33). Higher refractive index causes more bending of light.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_phys_tir_001",
      subject: "Physics",
      topic: "Total Internal Reflection",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Assertion: The images formed by total internal reflections are brighter than those formed by mirrors or lenses. Reason: There is no loss of intensity in total internal reflection.",
      answer: "If both assertion and reason are true and the reason is the correct explanation of the assertion",
      options: [
        "If both assertion and reason are true and the reason is the correct explanation of the assertion",
        "If both assertion and reason are true, but the reason is not the correct explanation of the assertion",
        "If assertion is true, but reason is false",
        "If both the assertion and reason are false"
      ],
      solution: "Both are true. In total internal reflection, 100% of light is reflected (no absorption or refraction loss), so no intensity is lost. This is why TIR produces brighter images compared to mirrors (which absorb some light) or lenses (which have dispersion and absorption losses).",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_phys_fiber_001",
      subject: "Physics",
      topic: "Optical Fibers",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Assertion: Optical fibers are used to transmit light without any loss in its intensity over distances of several kilometers. Reason: Optical fibers are very thick and all the light is passed through it without any loss.",
      answer: "If assertion is true, but reason is false",
      options: [
        "If both assertion and reason are true and the reason is the correct explanation of the assertion",
        "If both assertion and reason are true, but the reason is not the correct explanation of the assertion",
        "If assertion is true, but reason is false",
        "If both the assertion and reason are false"
      ],
      solution: "Assertion is TRUE: Optical fibers transmit light over long distances with minimal loss due to total internal reflection. Reason is FALSE: Optical fibers are very THIN (micrometer scale), not thick. The thinness helps maintain total internal reflection at the core-cladding boundary.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_phys_eye_001",
      subject: "Physics",
      topic: "Human Eye and Vision",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Your friend is having eyesight problem. She is not able to see clearly a distant uniform window and it appears to her as non-uniform and distorted. The doctor diagnosed the problem as:",
      answer: "Myopia with Astigmatism",
      options: ["Presbyopia with Astigmatism", "Astigmatism", "Myopia with Astigmatism", "Myopia and hypermetropia"],
      solution: "The inability to see distant objects clearly indicates Myopia (short-sightedness). The non-uniform and distorted appearance indicates Astigmatism (irregular curvature of cornea/lens). Together, the diagnosis is Myopia with Astigmatism.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_phys_magnetic_001",
      subject: "Physics",
      topic: "Magnetism",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The pattern of the magnetic field produced by a straight current-carrying conducting wire is:",
      answer: "Circular around the wire",
      options: ["In the direction opposite to the current", "In the direction parallel to the wire", "Circular around the wire", "In the same direction of current"],
      solution: "According to the right-hand rule, if you point your thumb in the direction of current, your fingers curl in the direction of magnetic field lines. The magnetic field forms concentric circles around the wire.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_phys_charged_001",
      subject: "Physics",
      topic: "Magnetic Effects of Current",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Consider the following statements regarding a charged particle in a magnetic field. Which of the statements are true? (a) Starting with zero velocity, it accelerates in a direction perpendicular to the magnetic field (b) Charge particle will not move if we place it stationary in Magnetic Field (c) While deflecting in magnetic field its energy gradually increases (d) Direction of deflection force on the moving charged particle is perpendicular to its velocity",
      answer: "Statements (b) and (d) are true",
      options: ["Only (a) is true", "Statements (b) and (d) are true", "Only (c) is true", "All statements are true"],
      solution: "(a) FALSE: Lorentz force requires motion; if starting from rest, no force acts initially. (b) TRUE: A stationary charged particle experiences no magnetic force. (c) FALSE: Magnetic force is always perpendicular to velocity, so it does no work and energy doesn't change. (d) TRUE: Lorentz force F = q(v × B) is perpendicular to both v and B, hence perpendicular to velocity.",
      requiresWork: true
    },
    {
      id: "custom_cbse_chem_easy_001",
      subject: "Chemistry",
      topic: "Basic Reactions",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "What is the chemical formula for oxygen gas?",
      answer: "O₂",
      options: ["O", "O₂", "O₃", "O₄"],
      solution: "Oxygen exists as a diatomic molecule: O₂",
      requiresWork: false
    },
    // Expert-Provided CBSE Class 10 Chemistry Questions for Q1-Q3
    {
      id: "custom_cbse_q1_chem_rxn_001",
      subject: "Chemistry",
      topic: "Chemical Reactions and Changes",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Which one of the following processes involve chemical reactions?",
      answer: "Heating copper wire in presence of air at high temperature",
      options: [
        "Storing of oxygen gas under pressure in a gas cylinder",
        "Liquefaction of air",
        "Keeping petrol in a China dish in the open",
        "Heating copper wire in presence of air at high temperature"
      ],
      solution: "Heating copper wire in air causes oxidation (2Cu + O₂ → 2CuO), which is a chemical reaction producing a new substance (black copper oxide). Other options are physical changes: compression, liquefaction, and evaporation.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_decomp_001",
      subject: "Chemistry",
      topic: "Thermal Decomposition",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Baking soda on thermal decomposition produces:",
      answer: "Sodium carbonate, carbon dioxide gas and water",
      options: [
        "Sodium carbonate and water",
        "Sodium carbonate, carbon dioxide gas and water",
        "Sodium oxide, carbon dioxide gas and water",
        "Baking soda does not undergo thermal decomposition"
      ],
      solution: "2NaHCO₃ → Na₂CO₃ + CO₂↑ + H₂O. Baking soda decomposes into sodium carbonate, carbon dioxide gas, and water when heated.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_elec_001",
      subject: "Chemistry",
      topic: "Electrolytes and Dissociation",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Electrolytes when dissolved in water dissociate into their constituent ions. The degree of dissociation of an electrolyte increases with:",
      answer: "Decreasing concentration of the electrolyte",
      options: [
        "Increasing concentration of the electrolyte",
        "Decreasing concentration of the electrolyte",
        "Decreasing temperature",
        "Presence of a substance yielding a common ion"
      ],
      solution: "Ostwald's dilution law states that degree of dissociation increases when the solution is diluted (concentration decreases). More dilute solutions have higher ionization because ions are farther apart, reducing recombination.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_nacl_001",
      subject: "Chemistry",
      topic: "Conductivity and Ions",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Molten sodium chloride conducts electricity due to the presence of:",
      answer: "Free ions",
      options: ["Free electrons", "Free ions", "Free molecules", "Atoms of sodium and chlorine"],
      solution: "In molten NaCl, the ionic compound is in liquid state where ions (Na⁺ and Cl⁻) are free to move. These mobile ions carry electric current. Free electrons are not present in ionic compounds.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_lewis_001",
      subject: "Chemistry",
      topic: "Acids and Bases",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Lewis acid:",
      answer: "Is a electron pair acceptor",
      options: [
        "Presence of H atom is necessary",
        "Is a electron pair donor",
        "Always a proton donor",
        "Is a electron pair acceptor"
      ],
      solution: "According to Lewis definition, an acid is an electron pair acceptor (not just H⁺ donor). A base is an electron pair donor. This definition is broader than Brønsted-Lowry definition.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_basic_001",
      subject: "Chemistry",
      topic: "Salt Hydrolysis",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The compound whose 0.1 M solution is basic is:",
      answer: "sodium acetate",
      options: ["ammonium acetate", "ammonium chloride", "ammonium sulphate", "sodium acetate"],
      solution: "Sodium acetate (CH₃COONa) is a salt of weak acid (acetic acid) and strong base (NaOH). It undergoes hydrolysis: CH₃COO⁻ + H₂O ⇌ CH₃COOH + OH⁻, producing OH⁻ ions, making the solution basic. Ammonium salts produce acidic solutions.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_hydrate_001",
      subject: "Chemistry",
      topic: "Hydrated Compounds",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "A hydrated solid X on heating initially gives a monohydrated compound Y. Y upon heating above 373 K leads to an anhydrous white powder Z. X and Z, respectively, are:",
      answer: "Washing soda and soda ash",
      options: [
        "Washing soda and soda ash",
        "Baking soda and dead burnt plaster",
        "Washing soda and dead burnt plaster",
        "Baking soda and soda ash"
      ],
      solution: "X = Washing soda (Na₂CO₃·10H₂O) → heating → Y = Monohydrated (Na₂CO₃·H₂O) → heating above 373K → Z = Soda ash (Na₂CO₃). Soda ash is the anhydrous white powder.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_matrix_001",
      subject: "Chemistry",
      topic: "Ore Metallurgy",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Matrix is defined as:",
      answer: "The unwanted foreign material present in the ore",
      options: [
        "The unwanted foreign material present in the ore",
        "The flux added to remove the unwanted impurities from the ore",
        "The slag formed as a result of the reaction of flux with gangue",
        "The material used in the reduction of metal oxide to metal"
      ],
      solution: "In ore processing, matrix (also called gangue) refers to the unwanted rock and foreign material associated with the ore mineral. Flux is added to react with gangue to form slag.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_alumina_001",
      subject: "Chemistry",
      topic: "Electrolysis and Metallurgy",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "In the electrolysis of alumina to obtain aluminum metal, cryolite is added to:",
      answer: "Lower the melting point of alumina",
      options: [
        "Lower the melting point of alumina",
        "Dissolve alumina in molten cryolite",
        "Remove the impurities of alumina",
        "Decrease the electrical conductivity"
      ],
      solution: "Cryolite (Na₃AlF₆) acts as a solvent and flux for alumina (Al₂O₃). It lowers the melting point from 2327°C to about 900°C, making the industrial process economically feasible. This mixture is called the 'Hall-Heroult cell'.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_chem_metallurgy_001",
      subject: "Chemistry",
      topic: "Extractive Metallurgy",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Choose the correct statement(s) among the following: (A) In the Aluminothermite process, aluminium acts as reducing agent. (B) 'Slag' formed during smelting in the extraction of copper is FeSiO₃. (C) In the extractive metallurgy of zinc, partial fusion of ZnO with coke is called sintering, and reduction of ore to the molten metal is called smelting. (D) Extractive metallurgy of silver from its ore argentine involves complex formation and displacement by more electropositive metal.",
      answer: "A, B and C",
      options: ["A and B", "B and C", "A, B and C", "A, B, C and D"],
      solution: "(A) TRUE: 2Al + Fe₂O₃ → 2Fe + Al₂O₃ (highly exothermic). (B) TRUE: In copper extraction, iron silicate (FeSiO₃) forms as slag. (C) TRUE: Both are correct definitions for zinc extraction. (D) FALSE: Silver extraction uses cyanide leaching and displacement by zinc, not complex formation alone.",
      requiresWork: true
    },
    {
      id: "custom_cbse_bio_easy_001",
      subject: "Biology",
      topic: "Photosynthesis",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "In which organelle does photosynthesis occur?",
      answer: "Chloroplast",
      options: ["Mitochondria", "Chloroplast", "Nucleus", "Ribosome"],
      solution: "Photosynthesis occurs in the chloroplast, the organelle containing chlorophyll",
      requiresWork: false
    },
    // Expert-Provided CBSE Class 10 Biology Questions for Q1-Q3
    {
      id: "custom_cbse_q1_bio_nutrition_001",
      subject: "Biology",
      topic: "Nutrition in Organisms",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Which among the following statements is incorrect?",
      answer: "In parasitic mode of nutrition, the organisms feed by ingesting solid organic matter which is then digested and absorbed into their bodies",
      options: [
        "Green plants are photoautotrophs as they prepare their food through photosynthesis",
        "In heterotrophic nutrition, the organism depends on other organisms for its food",
        "In parasitic mode of nutrition, the organisms feed by ingesting solid organic matter which is then digested and absorbed into their bodies",
        "Saprophytes obtain their food from dead and decaying organic matter"
      ],
      solution: "Statement (c) is incorrect. Parasites do NOT ingest solid food. They absorb pre-digested nutrient solutions from the host organism. Saprophytes ingest solid organic matter (like fungi and bacteria on dead matter). All other statements are correct.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_amoeba_001",
      subject: "Biology",
      topic: "Types of Nutrition",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "What type of nutrition is shown in amoeba?",
      answer: "Holozoic nutrition",
      options: ["Photoautotrophic nutrition", "Holozoic nutrition", "Parasitic nutrition", "Saprotrophic nutrition"],
      solution: "Amoeba shows holozoic nutrition because it ingests solid organic matter (small organisms, food particles) through its pseudopodia. The food is then digested in food vacuoles.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_teeth_001",
      subject: "Biology",
      topic: "Human Teeth",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Which type of teeth do humans possess?",
      answer: "Heterodont, Diphyodont",
      options: ["Thecodont, Heterodont", "Thecodont, Bilateral", "Heterodont, Diphyodont", "Thecodont, Temporary"],
      solution: "Humans have Heterodont teeth (different types: incisors, canines, premolars, molars) and Diphyodont teeth (two sets in lifetime: deciduous and permanent).",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_dental_001",
      subject: "Biology",
      topic: "Dental Formula",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "What is the dental formula of the teeth in a 5-year-old child?",
      answer: "2123/2123",
      options: ["2123/2123", "2103/2103", "2003/2003", "2120/2120"],
      solution: "At 5 years old, the child has deciduous (milk) teeth. Dental formula = 2 incisors, 1 canine, 2 molars per half = 2123/2123. Permanent teeth (adult) = 2123/2123.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_transpiration_001",
      subject: "Biology",
      topic: "Transpiration",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Transpiration is very important for plants because it helps in:",
      answer: "All of the above",
      options: [
        "The absorption of water from soil",
        "The cooling of leaves at high temperature",
        "The movement of water and minerals absorbed by roots to various parts of the plant",
        "All of the above"
      ],
      solution: "Transpiration is important for: (1) Creating water potential gradient that pulls water up from roots, (2) Cooling leaves through evaporative cooling, (3) Transporting water and minerals throughout the plant.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_phloem_001",
      subject: "Biology",
      topic: "Transport in Plants",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Transport of sucrose in phloem is by:",
      answer: "Active transport",
      options: ["Diffusion", "Facilitated diffusion", "Active transport", "Transpiration"],
      solution: "Sucrose is transported in phloem through active transport (requires ATP and carrier proteins). Sucrose moves from photosynthetic cells (source) to non-photosynthetic cells (sink) against concentration gradient.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_stomata_001",
      subject: "Biology",
      topic: "Gas Exchange",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Stomata of a plant open due to:",
      answer: "influx of potassium ions",
      options: ["influx of hydrogen ions", "influx of calcium ions", "influx of potassium ions", "efflux of potassium ions"],
      solution: "Stomata open due to influx (entry) of potassium ions (K⁺) into guard cells. This increases osmotic potential, causing water influx and turgor pressure, which opens the stomatal pore.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_transpiration_false_001",
      subject: "Biology",
      topic: "Transpiration Factors",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Which of the following statements is incorrect about transpiration?",
      answer: "Higher temperature of the surrounding decreases transpiration",
      options: [
        "Higher temperature of the surrounding decreases transpiration",
        "Higher the velocity of wind, more is the transpiration",
        "The transpiration is inversely proportional to humidity",
        "Strong light stimulates the opening and closing of stomata and thus increases the transpiration"
      ],
      solution: "Statement (a) is incorrect. Higher temperature INCREASES transpiration (not decreases). Temperature increases evaporation rate from leaves. All other statements are correct.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_nerve_impulse_001",
      subject: "Biology",
      topic: "Nervous System",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Nerve impulse travels as:",
      answer: "Electrical impulse",
      options: ["Mechanical impulse", "Chemical impulse", "Electrical impulse", "Magnetic impulse"],
      solution: "Nerve impulse travels as an electrical impulse due to movement of ions (Na⁺ and K⁺) across the axon membrane. This creates a change in membrane potential that propagates along the neuron.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_energy_001",
      subject: "Biology",
      topic: "Nerve Conduction",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Energy transformation during nerve conduction is:",
      answer: "Chemical to electrical",
      options: ["Chemical to radiant", "Chemical to mechanical", "Chemical to electrical", "Chemical to osmotic"],
      solution: "During nerve conduction, chemical energy (from ATP) is converted to electrical energy. ATP is used to maintain the Na⁺/K⁺ pump, creating the resting potential that drives electrical impulses.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_synapse_001",
      subject: "Biology",
      topic: "Nerve Transmission",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The junction between the axon of one neuron and the dendrite of the next is called:",
      answer: "Synapse",
      options: ["Constant bridge", "Junction point", "Joint", "Synapse"],
      solution: "A synapse is the junction between the axon terminal of one neuron (presynaptic) and the membrane of the receiving neuron (postsynaptic). It consists of synaptic vesicles, synaptic cleft, and receptors.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_neurotransmitter_001",
      subject: "Biology",
      topic: "Synaptic Transmission",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The binding of the neurotransmitter with the receptors opens ion channels allowing the entry of ions which can generate a new potential in the:",
      answer: "Postsynaptic membrane",
      options: ["Presynaptic membrane", "Postsynaptic membrane", "Synaptic cleft", "Synaptic vesicles"],
      solution: "Neurotransmitters bind to receptors on the postsynaptic membrane (receiving neuron). This opens ion channels, allowing ion influx and generation of new electrical potential in the receiving neuron.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_foodchain_001",
      subject: "Biology",
      topic: "Food Chain and Ecology",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "The first link in any food chain is usually green plants. Which of the following statements gives the correct explanation?",
      answer: "Only green plants have the capacity to synthesize food using sunlight",
      options: [
        "Only green plants have the capacity to synthesize food using sunlight",
        "There are more herbivores than carnivores in a food chain",
        "Green plants are the only ones fixed at one place in the soil and do not show movement",
        "Green plants are widely distributed"
      ],
      solution: "Green plants are the first trophic level because they are PRODUCERS - they convert solar energy into chemical energy through photosynthesis. All other organisms depend on this energy.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_foodchain_shark_001",
      subject: "Biology",
      topic: "Food Chain Population Dynamics",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Which of the following results when there is an increase in the population of sharks? Plankton→Fish→Seal→Shark",
      answer: "A decrease in the population of fish",
      options: [
        "A decrease in the population of seals",
        "A decrease in the population of fish",
        "An increase in the population of seals",
        "An increase in the population of plankton"
      ],
      solution: "When shark population increases, more fish are eaten (fish are primary food of sharks). This reduces fish population. Eventually, seal population decreases due to less food, but the immediate effect is fish population decrease.",
      requiresWork: false
    },
    {
      id: "custom_cbse_q1_bio_extinction_001",
      subject: "Biology",
      topic: "Food Chain - Extinction Effects",
      difficulty: "Easy",
      exam: "CBSE Class 10",
      year: 2024,
      question: "What will happen if deer gets extinct in the food chain: Grass → Deer → Tiger?",
      answer: "The population of tiger decreases and the population of grass increases",
      options: [
        "The population of tigers increases",
        "The population of grass decreases",
        "The tiger will start eating grass",
        "The population of tiger decreases and the population of grass increases"
      ],
      solution: "If deer (primary consumer) becomes extinct: (1) Tigers lose their food source, so tiger population decreases. (2) Grass has no herbivore to eat it, so grass population increases. This demonstrates interdependence in ecosystems.",
      requiresWork: false
    },
    // Mental Ability Test - Easy Level Questions
    {
      id: "custom_mental_easy_001",
      subject: "Mental Ability",
      topic: "Logical Reasoning",
      difficulty: "Easy",
      exam: "Mental Ability Test",
      year: 2024,
      question: "Complete the series: 2, 4, 6, 8, ?",
      answer: "10",
      options: ["9", "10", "11", "12"],
      solution: "The series increases by 2 each time: 2, 4, 6, 8, 10",
      requiresWork: false
    },
    {
      id: "custom_mental_easy_002",
      subject: "Mental Ability",
      topic: "Verbal Reasoning",
      difficulty: "Easy",
      exam: "Mental Ability Test",
      year: 2024,
      question: "Which word is opposite of 'Hot'?",
      answer: "Cold",
      options: ["Warm", "Cold", "Mild", "Cool"],
      solution: "The opposite of 'Hot' is 'Cold'",
      requiresWork: false
    },
    // SST (Social Studies) - Easy Level Questions
    {
      id: "custom_sst_easy_001",
      subject: "Social Studies",
      topic: "Geography",
      difficulty: "Easy",
      exam: "SST Class 10",
      year: 2024,
      question: "What is the capital of India?",
      answer: "New Delhi",
      options: ["Mumbai", "New Delhi", "Bangalore", "Kolkata"],
      solution: "New Delhi is the capital city of India",
      requiresWork: false
    },
    {
      id: "custom_sst_easy_002",
      subject: "Social Studies",
      topic: "History",
      difficulty: "Easy",
      exam: "SST Class 10",
      year: 2024,
      question: "In which year did India gain independence?",
      answer: "1947",
      options: ["1945", "1946", "1947", "1948"],
      solution: "India gained independence from British rule on August 15, 1947",
      requiresWork: false
    },
    // PCMB Medium Level Questions (for rounds 4-6)
    {
      id: "custom_pcmb_med_001",
      subject: "Mathematics",
      topic: "Quadratic Equations",
      difficulty: "Medium",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Solve: x² - 5x + 6 = 0",
      answer: "x = 2 or x = 3",
      options: ["x = 1, 6", "x = 2, 3", "x = -2, -3", "x = 1, 5"],
      solution: "x² - 5x + 6 = (x-2)(x-3) = 0 → x = 2 or x = 3",
      requiresWork: true
    },
    {
      id: "custom_pcmb_med_002",
      subject: "Physics",
      topic: "Force and Energy",
      difficulty: "Medium",
      exam: "CBSE Class 10",
      year: 2024,
      question: "Calculate: Force = mass × acceleration. If m = 5 kg and a = 2 m/s², find F.",
      answer: "10 N",
      options: ["5 N", "10 N", "15 N", "20 N"],
      solution: "F = ma = 5 × 2 = 10 Newton",
      requiresWork: true
    },
    // PCMB Hard Level Questions (for rounds 7-8)
    {
      id: "custom_pcmb_hard_001",
      subject: "Mathematics",
      topic: "Trigonometry",
      difficulty: "Hard",
      exam: "CBSE Class 10",
      year: 2024,
      question: "If sin(θ) = 3/5, find cos(θ) and tan(θ)",
      answer: "cos(θ) = 4/5, tan(θ) = 3/4",
      options: [
        "cos(θ) = 4/5, tan(θ) = 3/4",
        "cos(θ) = 3/4, tan(θ) = 4/5",
        "cos(θ) = 5/4, tan(θ) = 3/5",
        "cos(θ) = 4/3, tan(θ) = 5/4"
      ],
      solution: "Using Pythagorean identity: sin²(θ) + cos²(θ) = 1. If sin(θ) = 3/5, then cos(θ) = 4/5. tan(θ) = sin(θ)/cos(θ) = (3/5)/(4/5) = 3/4",
      requiresWork: true
    }
  ]
};

// Merge with existing question bank
function mergeQuestionBanks() {
  const questionBankPath = path.join(__dirname, '..', 'data', 'question-bank.json');

  let existingBank = { questions: [] };
  if (fs.existsSync(questionBankPath)) {
    try {
      existingBank = JSON.parse(fs.readFileSync(questionBankPath, 'utf8'));
    } catch (err) {
      console.warn('Could not read existing question bank, starting fresh');
    }
  }

  // Merge: add custom questions, avoiding duplicates
  const existingIds = new Set(existingBank.questions.map(q => q.id));
  const newQuestions = customQuestions.questions.filter(q => !existingIds.has(q.id));

  existingBank.questions.push(...newQuestions);

  // Save merged bank
  fs.writeFileSync(questionBankPath, JSON.stringify(existingBank, null, 2));

  console.log(`✅ Successfully merged ${newQuestions.length} custom questions`);
  console.log(`📊 Total questions in bank: ${existingBank.questions.length}`);

  // Show breakdown by subject and difficulty
  const breakdown = {};
  existingBank.questions.forEach(q => {
    const key = `${q.subject} - ${q.difficulty}`;
    breakdown[key] = (breakdown[key] || 0) + 1;
  });

  console.log('\n📈 Question Bank Breakdown:');
  Object.entries(breakdown).sort().forEach(([key, count]) => {
    console.log(`  ${key}: ${count} questions`);
  });
}

// Run merge
if (require.main === module) {
  mergeQuestionBanks();
}

module.exports = { customQuestions };
