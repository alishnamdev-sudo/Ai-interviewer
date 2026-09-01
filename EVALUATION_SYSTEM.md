# AI Interview Evaluation System - Complete Algorithm

## Overview

The interview evaluation system uses a **two-tier scoring approach**:

1. **Problem-Solving Evaluation** — Individual whiteboard round scoring (0-10)
2. **Overall Report Evaluation** — Comprehensive assessment using weighted categories (0-100)

---

## Tier 1: Problem-Solving Evaluation

### When It Runs
- During **PROBLEM_SOLVE** stage
- Each of 8 whiteboard rounds (Subject: Maths, Physics, Chemistry, etc.)
- Evaluated immediately after candidate submits solution

### Input Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `question` | string | Problem statement |
| `subject` | string | Math, Physics, Chemistry, etc. |
| `imageBase64` | image | Whiteboard drawing (handwritten solution) |
| `dictatedText` | string | Candidate's spoken explanation (transcribed) |
| `evalContext` | string | Ground truth answer/solution |
| `requiresWork` | boolean | If true, must evaluate full working; if false, accept final answer |

### Scoring Rubric (for requiresWork problems)

**Scale: 0-10**

```
Step 1: Extract "workShown"
  - Exact steps visible in whiteboard image + spoken explanation
  - Write "none — final answer only" if no method shown
  - Write exact steps if methodology is visible

Step 2: Score based on workShown
  0-4:  Final answer only, no working shown (auto-cap at 4)
  4-6:  Correct method, but arithmetic/sign errors
  6-8:  Sound approach, visible steps, small calculation slip near end
  8-10: Correct method AND correct final answer

Step 3: Category Scoring
  - Method choice: correct for this problem?
  - Setup/substitution: correct equations, values, units?
  - Intermediate steps: chain visible, ordered, mathematically valid?
  - Final answer: correct value/option with units?
```

### Evaluation Constraints

- **Never credit unseen steps** — Only score what is visible on whiteboard or spoken
- **Full approach evaluation** — Not just final answer
- **Units matter** — Missing units = score penalty
- **Signs matter** — Wrong sign = step is wrong
- **Method first** — Right method, wrong arithmetic = higher score than right answer, wrong method

### Output: Individual Round Score

```json
{
  "isCorrect": true/false,
  "score": 8,
  "workShown": "correct setup with energy conservation, but mass substituted in grams not kg",
  "evaluation": "Sound physics reasoning with correct approach. Minor unit conversion error reduced the final value.",
  "feedback": "Double-check unit conversions when substituting into equations.",
  "followUpQuestion": "Why did you choose energy conservation over force analysis here?"
}
```

### Problem-Solving Score Aggregation

**Final Problem Score = Average of 8 round scores**

- Rounds 1-3: Difficulty level "Easy/Medium"
- Rounds 4-6: Difficulty level "Medium/Hard"
- Rounds 7-8: Difficulty level "Hard"

**Early Exit Conditions:**
- **Max Consecutive Wrong:** If 3+ rounds wrong in a row → Interview ends
- **Checkpoint (Round 5):** If accuracy < 80% by round 5 → Interview ends

---

## Tier 2: Overall Report Evaluation

### When It Runs
- After interview completes (all stages done)
- Or when interview is interrupted/ended early
- Uses Gemini 2.5 Flash (LLM-based evaluation)

### Input Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `transcript` | string | Complete interview transcript (all Q&A + camera analysis) |
| `teacherName` | string | Candidate's name |
| `subject` | string | Subject taught (Math, Chemistry, English, etc.) |
| `problemScore` | number | Average of 8 problem-solving rounds (0-10) |
| `misconductCount` | number | Number of conduct warnings issued |
| `endedForMisconduct` | boolean | True if interview terminated for repeated inappropriate behavior |
| `recordingId` | string | Video recording ID (if saved) |
| `interrupted` | boolean | True if interview was cut short (tab close, network, etc.) |
| `interruptedAt` | number | Stage index where interrupted (0=wellbeing, 1=resume, 2=problem, 3=wrap) |

### Scoring Weights (Weighted Average)

```
Overall Score = Weighted Average of 5 Categories

Category Weights:
├── Problem Solving Ability:     40% ← PRIMARY (tied to problemScore)
├── Communication Skills:         15%
├── Subject Knowledge:            15%
├── Teaching Methodology:         15%
└── Student-Centric Approach:     15%

Formula:
overallScore = (problemScore × 0.40) + (commSkills × 0.15) + (subjectKnowledge × 0.15) + (teachingMethod × 0.15) + (studentCentric × 0.15)
```

### Category Scoring (Each 0-100)

**1. Problem Solving Ability (40% weight)**
- Directly uses `problemScore` from whiteboard rounds
- Most heavily weighted criteria
- Reflects candidate's ability to solve complex problems under time pressure

**2. Communication Skills (15% weight)**
- Clarity in explaining concepts
- Ability to articulate reasoning
- Listening and responsiveness to AI's questions
- Assessed from RESUME_QA and PROBLEM_SOLVE transcript

**3. Subject Knowledge (15% weight)**
- Accuracy of content
- Depth of understanding
- Correctness in explanations
- No major misconceptions

**4. Teaching Methodology (15% weight)**
- How would they teach a student?
- Structured approach to problem-solving
- Use of examples and explanations
- Pedagogical clarity

**5. Student-Centric Approach (15% weight)**
- Concern for student learning
- Ability to adapt explanations
- Empathy and patience
- Awareness of different learning styles

### Special Modifiers

**Camera Analysis (Engagement Score)**
- ~30-second webcam snapshots throughout interview
- Behavioral observations added to transcript
- Used ONLY for `engagementNotes`
- Does NOT affect overallScore

**Conduct Flags**
- If `endedForMisconduct = true`:
  - Recommendation forced to "Not Recommended"
  - Summary explicitly mentions conduct violation
  - Score penalized significantly
- If `misconductCount > 0` but interview completed:
  - Note in transcript but NO score penalty
  - Candidate evaluated purely on substance

**Interruption Flags**
- If `interrupted = true`:
  - Prompt tells LLM this is incomplete
  - Candidate NOT penalized for missing sections
  - Summary flagged as "partial submission"
  - Recommended for human review

### Recommendation Thresholds

```
Overall Score → Recommendation

80-100:  Highly Recommended
60-79:   Recommended
40-59:   Needs Improvement
0-39:    Not Recommended

If endedForMisconduct = true:
→ Always "Not Recommended" (regardless of score)
```

### Output: Final Report

```json
{
  "overallScore": 72,
  "summary": "Strong problem-solver with solid subject knowledge, though communication clarity could be enhanced. Well-structured methodology but needs to better address diverse student learning needs.",
  "recommendation": "Recommended",
  "categories": [
    {
      "name": "Problem Solving Ability",
      "score": 75,
      "feedback": "Solid approach to mathematical problems; recovered well from minor errors."
    },
    {
      "name": "Communication Skills",
      "score": 68,
      "feedback": "Explanations generally clear but could be more concise; some technical jargon not explained for students."
    },
    {
      "name": "Subject Knowledge",
      "score": 78,
      "feedback": "Strong grasp of chemistry concepts with accurate explanations and good depth."
    },
    {
      "name": "Teaching Methodology",
      "score": 70,
      "feedback": "Structured problem-solving approach; would benefit from more examples and real-world connections."
    },
    {
      "name": "Student-Centric Approach",
      "score": 72,
      "feedback": "Shows awareness of student difficulties; could demonstrate more personalized adaptation strategies."
    }
  ],
  "strengths": [
    "Excellent problem-solving under pressure",
    "Deep subject knowledge in core topics",
    "Structured and methodical approach"
  ],
  "improvements": [
    "Enhance communication clarity for diverse student levels",
    "Include more real-world examples in explanations",
    "Demonstrate flexibility in teaching approaches for different learning styles"
  ],
  "conductFlagged": false,
  "interrupted": false,
  "engagementNotes": "Maintained good composure throughout; focused concentration during problem-solving; showed appropriate energy level during explanations."
}
```

---

## Interview Flow & Stage Breakdown

### Stage 0: WELLBEING (5-10 min)
- AI checks candidate's well-being
- Warm-up conversation
- Sets interview tone
- **No scoring yet**

### Stage 1: RESUME_QA (10-15 min)
- AI-generated questions based on resume
- Assesses teaching experience
- Probes subject knowledge
- **Contributes to:** Communication Skills, Subject Knowledge, Teaching Methodology

### Stage 2: PROBLEM_SOLVE (15-20 min)
- 8 whiteboard problem-solving rounds
- 120-180 seconds per problem
- Immediate feedback on each round
- **Scoring:** Problem Solving Ability (0-10) → averaged to final score

### Stage 3: WRAP_UP (2-3 min)
- Closing statement
- Thank you message
- **No scoring**

---

## Early Exit Conditions

### 1. Max Consecutive Wrong Answers
```
MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS = 3

If candidate gets 3+ problems wrong in a row:
  → Stop interview immediately
  → Skip remaining problems
  → Generate report with partial problem score
  → Flag as incomplete in report
```

### 2. Performance Checkpoint (Round 5)
```
PROBLEM_SOLVE_CHECKPOINT_ROUND = 5
PROBLEM_SOLVE_CHECKPOINT_MIN_ACCURACY = 0.8 (80%)

After problem 5:
  If accuracy < 80%:
    → Stop interview
    → Generate report (5 rounds only)
    → Flag as incomplete
  Else:
    → Continue to remaining 3 rounds
```

### 3. Max Consecutive Silences
```
MAX_CONSECUTIVE_SILENCES = 5
SILENCE_TIMEOUT_MS = 10,000 (10 seconds)

If candidate doesn't respond for 10s:
  → AI prompts again
  If happens 5+ times in a row:
    → Stop interview
    → Generate report
    → Note: "No response from candidate"
```

### 4. Conduct Violations
```
MAX_CONDUCT_WARNINGS = 2

Violations include:
  - Abusive/inappropriate language
  - Triggering/sensitive content
  
After 2 warnings:
  → Next violation ends interview immediately
  → Report marked: endedForMisconduct = true
  → Recommendation forced to "Not Recommended"
```

---

## Data Used in Transcript

### 1. Q&A Entries
```
[AI Interviewer] "What is your approach to differentiated learning?"
[Candidate] "I tailor my teaching to individual student needs..."
```

### 2. Conduct Flags
```
[Conduct Flag - Warning 1] "Candidate used inappropriate language in response to question about student discipline"
```

### 3. Camera Analysis
```
[Camera Analysis ~30s interval] "Good eye contact, appears engaged, slight tension around mouth during problem-solving"
```

### 4. Problem Solutions
```
[Problem 1 - Round 1] "Score: 8/10 - Correct method and answer"
[Problem 1 - Follow-up] "Candidate explained reasoning clearly"
```

---

## Key Design Principles

### 1. **Work > Answer**
Problems requiring full working are graded on methodology, not just final answer. A right answer with wrong method scores lower than wrong answer with correct method.

### 2. **Fairness for Interruptions**
Interrupted interviews are NOT penalized for incomplete sections. LLM told to evaluate only what was completed.

### 3. **Conduct Severity**
Repeated misconduct (3+ warnings) → interview ends immediately. Minor warnings don't affect scoring if interview completes.

### 4. **Diverse Assessment**
5 independent categories avoid over-relying on any single trait. Problem-solving weighted heavily (40%) as primary job requirement.

### 5. **Transparency**
Each score includes feedback. Candidates understand WHY they received each score.

### 6. **Teacher-Specific Criteria**
Unlike generic interviews, emphasis on:
- Teaching methodology (how they would teach others)
- Student-centric approach (empathy, adaptation)
- Subject knowledge (depth, not breadth)

---

## Scoring Statistics

### Typical Score Distributions

**Problem-Solving Rounds:**
- Average: 6.5/10
- Range: 0-10
- Most candidates: 5-8 range

**Overall Score:**
- Average: 65-75 (Recommended range)
- Highly Recommended: 15-20% of candidates
- Recommended: 50-60% of candidates
- Needs Improvement: 15-20% of candidates
- Not Recommended: 5-10% of candidates

### Category Scores (Typical)

| Category | Avg Score | Why |
|----------|-----------|-----|
| Problem Solving | 65 | Reflects whiteboard performance |
| Communication | 70 | Generally clear, some gaps |
| Subject Knowledge | 72 | Usually strong suit for teachers |
| Teaching Methodology | 68 | Often needs improvement |
| Student-Centric | 66 | Empathy varies widely |

---

## Admin Dashboard Display

Each report shows:

1. **Candidate Details**
   - Name, Subject, Date
   - Status: Completed, Interrupted, Ended for Misconduct

2. **Scores**
   - Overall: 72/100
   - Problem Solving: 6.8/10
   - 5 Category Scores (0-100 each)

3. **Recommendation**
   - Highly Recommended / Recommended / Needs Improvement / Not Recommended
   - Color-coded badge

4. **Summary & Strengths/Improvements**
   - 2-3 sentence overview
   - Key strengths (top 3)
   - Areas for improvement (top 2)

5. **Full Report**
   - Complete transcript
   - Category feedback (one sentence each)
   - Engagement notes
   - Recording link (if saved)

---

## Customization

### To Adjust Weights:
Edit in `server.js` line ~1067:
```javascript
SCORING WEIGHTAGE:
- Problem Solving Ability: 40% weight ← Change here
- Communication Skills: 15% weight   ← Change here
...
```

### To Adjust Problem Counts:
Edit in `app.js`:
```javascript
const PROBLEM_SOLVE_QUESTION_COUNT = 8; ← Change to 6, 10, etc.
const MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS = 3; ← Change to 2, 4, etc.
```

### To Adjust Timeouts:
Edit in `app.js`:
```javascript
const SILENCE_TIMEOUT_MS = 10000; ← 10 seconds
const PAUSE_TIMEOUT_MS = 3000;    ← 3 seconds after start speaking
```

---

## Summary

**Two-Tier Evaluation:**
1. **Problem-Solving** (0-10): Methodology + answer correctness
2. **Overall Report** (0-100): Weighted average of 5 categories

**Key Metrics:**
- 40% weight on problem-solving ability
- Fair evaluation of incomplete interviews
- Conduct violations trigger interview end
- Multiple categories prevent single-trait bias
- Transparent scoring with per-category feedback
