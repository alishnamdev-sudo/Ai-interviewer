require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most PaaS hosts) terminate TLS at a proxy in front of the app,
// so Express needs this to correctly see the request as secure — required
// for the session cookie's `secure` flag to work over HTTPS in production.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
  console.error('\n❌  GEMINI_API_KEY not configured.');
  console.error('   Open the .env file and paste your key after GEMINI_API_KEY=\n');
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.error('\n❌  ADMIN_PASSWORD not configured.');
  console.error('   Open the .env file and set ADMIN_PASSWORD to a strong password for viewing interview results.\n');
  process.exit(1);
}

app.use(express.json({ limit: '12mb' })); // whiteboard screenshots and resume uploads are base64-encoded

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  name: 'mt_admin_sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Admin Auth ────────────────────────────────────────────────────────────────
// Very small in-memory brute-force guard: 10 attempts per IP per 15 minutes.
const loginAttempts = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 0, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  return rec.count >= 10;
}
function recordFailedAttempt(ip) {
  const rec = loginAttempts.get(ip);
  if (rec) rec.count++;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.post('/api/admin/login', (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const expected = Buffer.from(process.env.ADMIN_PASSWORD);
  const given = Buffer.from(String(req.body.password || ''));
  const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);

  if (!match) {
    recordFailedAttempt(req.ip);
    return res.status(401).json({ error: 'Incorrect password' });
  }

  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/admin/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.get('/api/admin/reports', requireAdmin, (req, res) => {
  res.json(store.listReports());
});

app.get('/api/admin/reports/:id', requireAdmin, (req, res) => {
  const report = store.getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  res.json(report);
});

// ─── System Prompt Builder ────────────────────────────────────────────────────
function buildSystemPrompt(stage, teacherName, subject, resumeSummary) {
  const resumeBlock = resumeSummary
    ? `\nCANDIDATE RESUME — ALREADY KNOWN, DO NOT RE-ASK:\n${resumeSummary}\n\nThe facts above were extracted from the candidate's uploaded resume before the interview started. Treat every fact stated there as already answered. Never ask a question whose answer is already in this summary (e.g. their name, years of experience, current institute/designation, degrees, universities, specializations, or achievements already listed). Instead, during INTRO, EDUCATION, and TRACK_RECORD, briefly reference what you already know and ask ONE deeper or clarifying follow-up about it (e.g. "I see you've been teaching for 6 years at XYZ — what's been your biggest challenge there?"). If the resume already fully covers a stage's topic with no interesting follow-up needed, keep it to a single brief acknowledgment and move on quickly.\n`
    : '';

  return `You are a warm, highly professional interviewer at Vedantu, an Indian ed-tech company, evaluating a teacher's competency for the subject: ${subject}.
You are interviewing: ${teacherName || 'the candidate'}.
Current interview stage: ${stage}
${resumeBlock}
INDIAN CONTEXT: You are speaking with an Indian teacher about the Indian education system. Use natural
Indian-professional English (e.g. references to boards like CBSE/ICSE, exams like JEE/NEET, and terms
like PYQs are all familiar territory — no need to explain them). Address the candidate by their name
exactly as given above — never shorten, anglicize, or invent a nickname for it.

STAGE DESCRIPTIONS:
- WELLBEING   : Check how the teacher feels today; make them comfortable. 1-2 warm exchanges.
- INTRO       : Full name (if not known), total years of teaching, current institute and designation.
- EDUCATION   : Degrees earned, universities attended, year of completion, specialization.
- TRACK_RECORD: Competitive exam ranks/toppers produced, notable student achievements, number of institutes worked at and for how long.
- TEACHING_STYLE: How they explain complex concepts, how they handle slow learners, classroom engagement techniques.
- METHODOLOGY : PYQ (Previous Year Questions) practice — how many per class; theory vs. numericals balance; reference books used in teaching.
- PROBLEM_SOLVE: [This stage is handled by the UI — do NOT ask about it]
- EVALUATION  : Ask follow-up questions about the problem-solving solution the teacher just submitted.
- WRAP_UP     : Invite final thoughts; thank the teacher warmly.

STRICT RULES — violating these is unacceptable:
1. Ask EXACTLY ONE question per response. Never bundle two questions.
2. Keep every response under 35 words.
3. Acknowledge the previous answer briefly before asking the next question.
4. If an answer is vague, probe once more; do not probe endlessly.
5. When you have enough information for the current stage and are ready to move on,
   end your response with the exact token: [STAGE_COMPLETE]
   — do NOT explain the transition, just emit the token naturally after your closing sentence.
   CRITICAL: a response containing [STAGE_COMPLETE] must be a PURE acknowledgment
   with NO question in it at all — not even a soft or forward-looking one. The system
   moves straight to a separate opening question for the next stage immediately after
   this message, without waiting for a reply, so any question asked here will never
   actually be heard by the candidate.
6. Never repeat a question already asked.
7. Be warm, encouraging, and professional at all times.
8. The candidate may answer in English, Hindi, Tamil, Telugu, or Marathi (transcribed via speech
   recognition). ALWAYS respond in English yourself, regardless of which language they used —
   your reply is read aloud by an English text-to-speech voice, so it must be plain English text,
   never Hindi/Tamil/Telugu/Marathi script or transliteration.
9. Never ask about a fact already listed in the CANDIDATE RESUME block above — see the instructions
   there for how to handle INTRO, EDUCATION, and TRACK_RECORD when resume data is present.`;
}

// ─── /api/chat ────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { history = [], userMessage, stage, teacherName, subject, resumeSummary } = req.body;

    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: buildSystemPrompt(stage, teacherName, subject, resumeSummary),
      generationConfig: { temperature: 0.75, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } }
    });

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const fullText = result.response.text().trim();

    const stageComplete = fullText.includes('[STAGE_COMPLETE]');
    const text = fullText.replace(/\[STAGE_COMPLETE\]/g, '').trim();

    res.json({ text, stageComplete });
  } catch (err) {
    console.error('[/api/chat]', err.message);
    res.status(500).json({ error: 'AI response failed', details: err.message });
  }
});

// ─── /api/parse-resume ────────────────────────────────────────────────────────
const RESUME_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);

app.post('/api/parse-resume', async (req, res) => {
  try {
    const { fileBase64, mimeType } = req.body;

    if (!fileBase64 || !mimeType) {
      return res.status(400).json({ error: 'fileBase64 and mimeType are required' });
    }
    if (!RESUME_MIME_TYPES.has(mimeType)) {
      return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF, PNG, JPG, or TXT resume.' });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.2, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } }
    });

    const promptText = `You are extracting structured information from a teacher's resume/CV for an interview system. Read the attached document carefully.

Respond ONLY with the exact JSON object below — no markdown fences, no prose before or after it. If a field is not present in the resume, use null (or an empty array for list fields). Do not invent information that isn't in the document.
{
  "name": "candidate's full name or null",
  "yearsExperience": "e.g. '6 years' or null",
  "currentInstitute": "current/most recent institute and designation, or null",
  "education": ["degree, institution, year — one string per entry"],
  "subjectsTaught": ["subject 1", "subject 2"],
  "achievements": ["notable ranks, toppers produced, awards, or accomplishments — one string per entry"],
  "summaryText": "A concise 3-5 sentence third-person summary of this candidate's background, suitable for briefing an interviewer so they don't re-ask basic biographical questions."
}`;

    const data = fileBase64.replace(/^data:[\w/+-]+;base64,/, '');
    const parts = [{ text: promptText }, { inlineData: { mimeType, data } }];

    const result = await model.generateContent(parts);
    let raw = result.response.text().trim();
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const parsed = JSON.parse(raw);
    res.json({ success: true, resume: parsed });
  } catch (err) {
    console.error('[/api/parse-resume]', err.message);
    res.status(500).json({ error: 'Could not analyse the resume. Please try a different file.', details: err.message });
  }
});

// ─── /api/evaluate ────────────────────────────────────────────────────────────
app.post('/api/evaluate', async (req, res) => {
  try {
    const { question, subject, imageBase64, dictatedText } = req.body;

    if (!imageBase64 && !dictatedText) {
      return res.json({
        isCorrect: false,
        score: 0,
        evaluation: 'No solution was submitted before time ran out.',
        feedback: 'Try to get at least a partial working down before the timer expires next time.',
        followUpQuestion: 'Can you talk me through how you would have approached this problem?'
      });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.4, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } }
    });

    let solutionDescription = '';
    if (imageBase64) {
      solutionDescription += `The teacher wrote their working by hand on a whiteboard, shown in the attached image. Read the handwriting carefully and evaluate the mathematical steps shown.\n`;
    }
    if (dictatedText) {
      solutionDescription += `The teacher also gave this spoken explanation of their solution (transcribed):\n"${dictatedText}"\n`;
    }

    const promptText = `You are evaluating a ${subject} teacher's solution to a problem, given under 90-second time pressure.

PROBLEM:
${question}

${solutionDescription}
Evaluate the solution and respond ONLY with the exact JSON object below — no markdown fences, no prose before or after it. This applies even if the image is blank, illegible, or contains no relevant work: in that case still return the JSON with score 0 and explain why in the evaluation field. Never reply with plain text or an apology instead of the JSON.
{
  "isCorrect": true,
  "score": 8,
  "evaluation": "2-3 sentence honest evaluation of correctness and quality",
  "feedback": "One constructive sentence on what could be improved",
  "followUpQuestion": "One concise probing question about their reasoning or approach"
}`;

    const parts = [{ text: promptText }];
    if (imageBase64) {
      const data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      parts.push({ inlineData: { mimeType: 'image/png', data } });
    }

    const result = await model.generateContent(parts);
    let raw = result.response.text().trim();
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err) {
    console.error('[/api/evaluate]', err.message);
    // Graceful fallback
    res.json({
      isCorrect: false,
      score: 5,
      evaluation: 'Your solution has been received and noted.',
      feedback: 'Please review your working for any missed steps.',
      followUpQuestion: 'Can you explain the key reasoning behind your approach?'
    });
  }
});

// ─── /api/report ──────────────────────────────────────────────────────────────
app.post('/api/report', async (req, res) => {
  try {
    const { transcript, teacherName, subject, problemScore } = req.body;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.5, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } }
    });

    const prompt = `Generate a thorough, fair evaluation report for ${teacherName}, a ${subject} teacher, based on their interview.

FULL INTERVIEW TRANSCRIPT:
${transcript}

Problem-Solving Score: ${problemScore}/10

Respond ONLY in this exact JSON format (no markdown fences):
{
  "overallScore": 75,
  "summary": "2-3 balanced sentences summarising the teacher's overall performance",
  "recommendation": "Highly Recommended",
  "categories": [
    { "name": "Communication Skills",      "score": 80, "feedback": "one concise sentence" },
    { "name": "Subject Knowledge",         "score": 75, "feedback": "one concise sentence" },
    { "name": "Teaching Methodology",      "score": 70, "feedback": "one concise sentence" },
    { "name": "Problem Solving Ability",   "score": 65, "feedback": "one concise sentence" },
    { "name": "Student-Centric Approach",  "score": 80, "feedback": "one concise sentence" }
  ],
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "improvements": ["area for improvement 1", "area for improvement 2"],
  "recommendation": "Highly Recommended | Recommended | Needs Improvement | Not Recommended"
}`;

    const result = await model.generateContent(prompt);
    let raw = result.response.text().trim();
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const reportData = JSON.parse(raw);
    const submissionId = store.saveReport({ teacherName, subject, problemScore, transcript, report: reportData });

    // The report itself is never sent back to the candidate's browser — it's
    // only retrievable later through the password-protected /admin dashboard.
    res.json({ success: true, submissionId });
  } catch (err) {
    console.error('[/api/report]', err.message);
    res.status(500).json({ error: 'Report generation failed', details: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🎙️  Vedantu MT AI Interview');
  console.log(`🌐  http://localhost:${PORT}`);
  console.log('📋  Press Ctrl+C to stop\n');
});
