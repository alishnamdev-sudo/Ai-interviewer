# Adding Custom Questions from PDFs to V-Select

## Overview

V-Select automatically assigns question difficulty based on rounds:
- **Questions 1-3**: Easy level (fallback to Medium)
- **Questions 4-6**: Medium level (fallback to Hard)  
- **Questions 7-8**: Hard level (fallback to Medium)

## Step 1: Extract Questions from Your PDFs

### Option A: Manual Extraction (Recommended for first time)

1. **Open your PDF files:**
   - PCMB Class 10 questions PDF
   - Mental Ability & SST questions PDF

2. **Extract questions in this format:**
   ```
   Subject: Mathematics
   Topic: Algebra
   Difficulty: Easy
   Question: Solve 2x + 5 = 13
   Answer: x = 4
   Options: x=3, x=4, x=5, x=6
   Solution: 2x + 5 = 13 → 2x = 8 → x = 4
   ```

### Option B: Use PDF Extraction Tool

Use an online tool to extract text:
1. Go to https://pdftotext.com or similar
2. Upload your PDF
3. Copy extracted text
4. Format into JSON (see Step 2)

## Step 2: Format Questions as JSON

Edit `scripts/parse-pdf-questions.js` and replace the `customQuestions` object with your questions.

### Format Template:

```javascript
{
  id: "custom_subject_level_001",           // unique ID
  subject: "Mathematics",                    // Math, Physics, Chemistry, Biology, Mental Ability, Social Studies
  topic: "Algebra",                          // specific topic
  difficulty: "Easy",                        // Easy, Medium, or Hard (IMPORTANT!)
  exam: "CBSE Class 10",                     // exam name
  year: 2024,                                // year
  question: "Solve: 2x + 5 = 13",           // the question text
  answer: "x = 4",                           // correct answer
  options: ["x = 3", "x = 4", "x = 5", "x = 6"],  // multiple choice options
  solution: "2x + 5 = 13 → 2x = 8 → x = 4",      // explanation
  requiresWork: false                        // true if student must show step-by-step work
}
```

## Step 3: Categorize Questions by Difficulty

### Easy Level (for Questions 1-3)
- Basic concepts
- Simple calculations
- Direct recall questions
- Example: "What is the capital of India?"

### Medium Level (for Questions 4-6)
- Moderate complexity
- Multi-step problems
- Application of concepts
- Example: "Solve a quadratic equation"

### Hard Level (for Questions 7-8)
- Complex problems
- Advanced concepts
- Require detailed working
- Example: "Derive and apply trigonometric identities"

## Step 4: Merge Questions into Question Bank

### Run the merger script:

```bash
node scripts/parse-pdf-questions.js
```

### Expected Output:
```
✅ Successfully merged 50 custom questions
📊 Total questions in bank: 1250

📈 Question Bank Breakdown:
  Biology - Easy: 15 questions
  Biology - Hard: 8 questions
  ...
```

## Step 5: Verify Questions Work

1. **Start the interview**
   ```bash
   npm start
   ```

2. **Begin an interview** and reach Problem Solving stage

3. **Check first 3 questions** - should be Easy level

4. **Check questions 7-8** - should be Hard level

## File Structure

```
scripts/
├── parse-pdf-questions.js          ← Edit this file
└── build-question-bank.js          ← Original JEE/NEET builder

data/
└── question-bank.json              ← Auto-updated with your questions
```

## Important Notes

### Question ID Naming Convention
```
custom_[subject]_[difficulty]_[number]
│       │        │            │
│       │        │            └─ 001, 002, etc
│       │        └─ easy, med, hard
│       └─ pcmb, mental, sst
└─ prefix for custom questions
```

### Avoid Duplicates
- Each question must have a unique `id`
- Duplicate IDs will be skipped during merge

### Subject Names
Use these exact names:
- `Mathematics`
- `Physics`
- `Chemistry`
- `Biology`
- `Mental Ability`
- `Social Studies`

### Difficulty Values (Case-Sensitive)
- `Easy`
- `Medium`
- `Hard`

## Example: Adding 10 Easy Questions

```javascript
const customQuestions = {
  questions: [
    // Easy - for rounds 1-3
    {
      id: "custom_pcmb_easy_001",
      subject: "Mathematics",
      topic: "Arithmetic",
      difficulty: "Easy",  // ← IMPORTANT for rounds 1-3
      exam: "CBSE Class 10",
      year: 2024,
      question: "What is 5 + 7?",
      answer: "12",
      options: ["10", "11", "12", "13"],
      solution: "5 + 7 = 12",
      requiresWork: false
    },
    // ... more 9 easy questions
  ]
};
```

## Troubleshooting

### Questions not appearing?
1. Check `data/question-bank.json` exists
2. Verify question `id` is unique
3. Check `difficulty` is exactly "Easy", "Medium", or "Hard"
4. Run: `node scripts/parse-pdf-questions.js` again

### Questions showing in wrong rounds?
1. Verify difficulty value (case-sensitive)
2. Check if question bank has enough questions of that difficulty
3. Ensure at least 3 Easy questions for rounds 1-3

### How to check current questions?
```bash
# View total questions by difficulty
cat data/question-bank.json | grep -o '"difficulty":"Easy"' | wc -l
```

## Production Deployment

Once your custom questions are working locally:

1. **Commit changes:**
   ```bash
   git add scripts/parse-pdf-questions.js data/question-bank.json
   git commit -m "Add custom PCMB and SST questions"
   git push origin main
   ```

2. **On production server:**
   - The updated `question-bank.json` will be deployed automatically
   - Existing interviews won't be affected

## Advanced: Auto-Extract from PDF

To automatically extract text from PDF files:

```bash
npm install pdfparse
node scripts/pdf-extractor.js your-file.pdf
```

(Script creation available upon request)

## Support

For issues or questions:
1. Check this guide's Troubleshooting section
2. Verify question format matches template exactly
3. Check console output from the merge script

---

**Happy question adding! Your custom questions are now part of V-Select's evaluation system.**
