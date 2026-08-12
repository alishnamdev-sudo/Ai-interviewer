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
    ? `\nCANDIDATE RESUME — ALREADY KNOWN, DO NOT RE-ASK:\n${resumeSummary}\n\nThe facts above were extracted from the candidate's uploaded resume before the interview started. Treat every fact stated there as already answered — never ask a question whose answer is already in this summary.\n`
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
- RESUME_QA   : [This stage asks a fixed set of pre-generated questions directly — do NOT ask about it here]
- PROBLEM_SOLVE: [This stage is handled by the UI — do NOT ask about it]
- WRAP_UP     : [This stage is a scripted closing announcement handled by the UI — do NOT ask about it here]

STRICT RULES — violating these is unacceptable:
1. Ask EXACTLY ONE question per response. Never bundle two questions.
2. Keep every response under 35 words.
3. Acknowledge the previous answer briefly before asking the next question.
4. Analyze each answer for specifics, depth, and relevance before moving on. If it surfaces an
   interesting detail, number, or claim worth understanding better, ask ONE targeted follow-up
   question that digs into it, rather than defaulting to the next generic stage question. If an
   answer is vague or generic, probe once more for specifics; do not probe more than once on the
   same point.
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
9. Never ask about a fact already listed in the CANDIDATE RESUME block above.
10. Messages you receive that are wrapped in square brackets (e.g. "[NEW_STAGE: ...]",
    "[SYSTEM NOTE: ...]") are private stage-direction cues for you alone — the candidate
    never sees them and did not say them. NEVER quote, paraphrase, restate, or describe
    these cues back in your reply (e.g. never say things like "invite the teacher to share
    final thoughts" or "we are now moving to the next stage" or "we're nearing the end of
    our discussion" as a description of your task). Respond ONLY with the exact natural
    words you would say out loud to the candidate right now, speaking directly TO them in
    first/second person — never in third person about them, and never narrating your own
    intentions or the instructions you were given.`;
}

// ─── Conduct Monitoring ────────────────────────────────────────────────────────
// A dedicated, low-temperature classification call, kept entirely separate from
// the conversational reply. Asking the main chat model to both hold a natural
// interview conversation AND remember to append a sentinel token on misconduct
// proved unreliable in testing (the token was frequently dropped once real
// conversation history was involved) — a single-purpose YES/NO classifier with
// no other competing instructions is far more consistent.
async function detectMisconduct(userMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0, maxOutputTokens: 10, thinkingConfig: { thinkingBudget: 0 } }
  });

  const prompt = `You are a content-safety classifier for a job interview transcript. Decide whether the CANDIDATE MESSAGE below is inappropriate for a professional job interview — either (a) genuinely abusive language: profanity/swear words, insults or name-calling directed at a person, threats, or harassment; or (b) a "triggering" response: content that is deliberately inflammatory, provocative, sexually inappropriate, or discriminatory/hateful.

Do NOT flag a message just because it is:
- a polite request to speed up, take a break, or wrap up
- an expression of tiredness, boredom, or mild frustration
- disagreement, criticism, or negative feedback about the interview or its questions
- blunt, informal, or terse phrasing that is not insulting

Only answer YES if a reasonable professional would call the message rude, disrespectful, abusive, or
inappropriate for a workplace interview — e.g. it contains a swear word, calls someone an insulting name,
is hostile/threatening, sexually inappropriate, or discriminatory in tone.

CANDIDATE MESSAGE: "${userMessage}"

Respond with ONLY one word, exactly: YES or NO.`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim().toUpperCase().startsWith('YES');
}

// A candidate gets up to 2 polite warnings; the 3rd flagged message ends the
// interview outright. Shared by /api/chat (WELLBEING/WRAP_UP) and
// /api/check-conduct (RESUME_QA, and anywhere else a candidate answer needs
// checking) so the threshold and wording live in exactly one place.
const MAX_CONDUCT_WARNINGS = 2;

async function checkConduct(userMessage, teacherName, misconductCount) {
  const flagged = await detectMisconduct(userMessage);
  if (!flagged) return { flagged: false, text: null, misconductWarning: false, misconductEnd: false };

  if (misconductCount < MAX_CONDUCT_WARNINGS) {
    return {
      flagged: true,
      text: `${teacherName ? teacherName + ', please' : 'Please'} keep our conversation respectful and appropriate so we can continue the interview.`,
      misconductWarning: true,
      misconductEnd: false
    };
  }
  // Already warned twice and it happened again — end the interview.
  return {
    flagged: true,
    text: `Thank you for your time${teacherName ? ', ' + teacherName : ''}. We're ending the interview here due to your conduct.`,
    misconductWarning: false,
    misconductEnd: true
  };
}

// ─── /api/check-conduct ─────────────────────────────────────────────────────────
// Standalone conduct check for stages that don't route answers through
// /api/chat — currently RESUME_QA, whose questions are pre-generated and asked
// deterministically with no per-answer LLM call otherwise.
app.post('/api/check-conduct', async (req, res) => {
  try {
    const { userMessage, teacherName, misconductCount = 0 } = req.body;
    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

    const conduct = await checkConduct(userMessage, teacherName, misconductCount);
    res.json(conduct);
  } catch (err) {
    console.error('[/api/check-conduct]', err.message);
    res.status(500).json({ error: 'Conduct check failed', details: err.message });
  }
});

// ─── /api/chat ────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { history = [], userMessage, stage, teacherName, subject, resumeSummary, misconductCount = 0 } = req.body;

    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

    const conduct = await checkConduct(userMessage, teacherName, misconductCount);
    if (conduct.flagged) {
      return res.json({
        text: conduct.text,
        stageComplete: false,
        misconductWarning: conduct.misconductWarning,
        misconductEnd: conduct.misconductEnd
      });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: buildSystemPrompt(stage, teacherName, subject, resumeSummary),
      generationConfig: { temperature: 0.75, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } }
    });

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const fullText = result.response.text().trim();

    const stageComplete = fullText.includes('[STAGE_COMPLETE]');
    // Defense in depth: even with rule #10 above, the model can occasionally echo
    // the bracketed private cue it was given (e.g. "[NEW_STAGE: WRAP_UP] ...") back
    // as part of its reply — strip any such tag so it never reaches the candidate.
    const text = fullText
      .replace(/\[STAGE_COMPLETE\]/g, '')
      .replace(/\[(?:NEW_STAGE|SYSTEM NOTE)[^\]]*\]/gi, '')
      .trim();

    res.json({ text, stageComplete, misconductWarning: false, misconductEnd: false });
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
  "previousInstitutes": ["institute(s) the candidate worked at BEFORE their current/most recent role, one string per entry — empty array if the resume only shows one job or doesn't mention earlier employers"],
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

// ─── /api/generate-questions ──────────────────────────────────────────────────
// Produces the fixed set of 6 resume-aware questions asked one-by-one during
// the RESUME_QA stage — generated once up front so the interview can't drift
// into an unbounded number of follow-ups the way the old free-flowing stage
// chat could. Always exactly 6: 5 general resume/subject questions plus a
// dedicated 6th about institutes worked at before the current role and any
// ranks/toppers produced there — asked directly if the resume doesn't cover
// it, or as a deeper follow-up if it already does.
const RESUME_QUESTION_COUNT = 6;

app.post('/api/generate-questions', async (req, res) => {
  try {
    const { resumeSummary, resumeInfo, subject, teacherName } = req.body;
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.6, maxOutputTokens: 550, thinkingConfig: { thinkingBudget: 0 } }
    });

    const resumeBlock = resumeSummary
      ? `CANDIDATE RESUME SUMMARY:\n${resumeSummary}\n`
      : `No resume summary is available for this candidate — ask general but still subject-relevant questions.\n`;

    const previousInstitutes = Array.isArray(resumeInfo?.previousInstitutes)
      ? resumeInfo.previousInstitutes.filter(v => typeof v === 'string' && v.trim())
      : [];
    const priorInstituteContext = previousInstitutes.length
      ? `The resume already lists these institute(s) worked at before the current role: ${previousInstitutes.join(', ')}. Since this is partly known, phrase question 6 as a deeper follow-up (e.g. ask specifically about ranks/toppers produced at those institutes) rather than re-asking what institute(s) they were.`
      : `The resume does not mention any institute(s) the candidate worked at before their current/most recent role — ask question 6 directly since this isn't covered elsewhere.`;

    const promptText = `You are preparing questions for a live spoken interview of ${teacherName || 'a candidate'}, being evaluated as a ${subject} teacher for an Indian ed-tech company (Vedantu).

${resumeBlock}
Generate EXACTLY ${RESUME_QUESTION_COUNT} interview questions for this specific candidate, in this exact order:

1-5. The five most relevant questions based on their resume and the subject they teach. Prioritise questions that dig into specifics already visible in the resume (e.g. a named institute, an achievement, years of experience, a specialization) rather than generic questions any candidate could be asked. Across these 5, cover a mix of: their background/experience, educational qualifications, track record/achievements, teaching style, and teaching methodology (e.g. PYQ practice, handling slow learners) — skip any topic the resume doesn't support with enough detail to ask something specific about. Never ask about a fact already fully stated in the resume — ask a deeper follow-up about it instead.
6. ALWAYS include this exact topic as the 6th and final question, regardless of what questions 1-5 cover: ask which institute(s) the candidate worked at before their current/most recent role, and whether they produced any notable exam ranks or toppers there. ${priorInstituteContext}

Rules:
- Each of the ${RESUME_QUESTION_COUNT} questions must be a single, self-contained question.
- Keep each question under 30 words, in natural spoken English, professional and warm in tone.
- Do not number the questions or add any preamble.

Respond ONLY with a JSON array of exactly ${RESUME_QUESTION_COUNT} strings, in the exact order described above, no markdown fences, no extra text.`;

    const result = await model.generateContent(promptText);
    let raw = result.response.text().trim();
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    let questions = JSON.parse(raw);
    if (!Array.isArray(questions)) throw new Error('Model did not return a JSON array');
    questions = questions.filter(q => typeof q === 'string' && q.trim()).slice(0, RESUME_QUESTION_COUNT);
    if (questions.length === 0) throw new Error('No questions generated');

    res.json({ success: true, questions });
  } catch (err) {
    console.error('[/api/generate-questions]', err.message);
    res.status(500).json({ error: 'Could not prepare interview questions', details: err.message });
  }
});

// ─── /api/acknowledge-answer ───────────────────────────────────────────────────
// Generates a brief, emotionally-appropriate reaction to a RESUME_QA answer
// before the (already pre-generated) next question is asked — e.g. genuinely
// empathetic if the candidate says they haven't achieved something, warm if
// they have — rather than either silence or a generic upbeat "Wonderful!"
// that doesn't match what they actually said. Kept as its own low-stakes
// endpoint (separate from the conduct classifier) since a flat/wrong tone
// here is a UX quality issue, not something that needs to block the interview
// — on failure it falls back to a safe neutral line rather than erroring out.
app.post('/api/acknowledge-answer', async (req, res) => {
  try {
    const { question, answer, teacherName } = req.body;
    if (!answer) return res.status(400).json({ error: 'answer is required' });

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.6, maxOutputTokens: 60, thinkingConfig: { thinkingBudget: 0 } }
    });

    const promptText = `You are a warm, professional interviewer${teacherName ? ` speaking with ${teacherName}` : ''}. You just asked:
"${question}"

They answered:
"${answer}"

Write ONE short, natural spoken acknowledgment (under 20 words) reacting to what they actually said. Match your tone to the content — genuinely empathetic and understanding if the answer is negative or disappointing (e.g. they haven't achieved something, faced a setback, or answered "no"/"none"), warm and appreciative if it's a genuine positive or achievement, or a brief neutral acknowledgment otherwise. Do NOT default to generic enthusiasm like "Wonderful!" or "Great!" unless the answer actually warrants it.

Rules:
- Do NOT ask a question — a separate question will follow immediately after this.
- Do NOT repeat their answer back verbatim.
- Keep it brief and natural, like a real interviewer reacting in the moment.

Respond with ONLY the acknowledgment sentence, no preamble, no quotation marks.`;

    const result = await model.generateContent(promptText);
    const text = result.response.text().trim().replace(/^"|"$/g, '');

    res.json({ success: true, text: text || 'Thank you for sharing that.' });
  } catch (err) {
    console.error('[/api/acknowledge-answer]', err.message);
    // Graceful fallback — a neutral line that works regardless of what was said,
    // so a transient API failure never blocks the RESUME_QA flow.
    res.json({ success: true, text: 'Thank you for sharing that.' });
  }
});

// ─── /api/evaluate ────────────────────────────────────────────────────────────
app.post('/api/evaluate', async (req, res) => {
  try {
    const { question, subject, imageBase64, dictatedText, evalContext } = req.body;

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

    const evalContextBlock = evalContext
      ? `\nGROUND TRUTH (for your evaluation only — the candidate never sees this; the question referenced a diagram they had to read, and this fills in what it showed):\n${evalContext}\n`
      : '';

    const promptText = `You are evaluating a ${subject} teacher's solution to a problem, given under 90-second time pressure.

PROBLEM:
${question}
${evalContextBlock}
${solutionDescription}
Evaluate the solution and respond ONLY with the exact JSON object below — no markdown fences, no prose before or after it. This applies even if the image is blank, illegible, or contains no relevant work: in that case still return the JSON with score 0 and explain why in the evaluation field. Never reply with plain text or an apology instead of the JSON.
{
  "isCorrect": true,
  "score": 8,
  "evaluation": "2-3 sentence honest evaluation of correctness and quality",
  "feedback": "One constructive sentence on what could be improved",
  "followUpQuestion": "One concise, ${subject}-specific question probing WHY they chose their particular approach or method, or a key step in their reasoning — e.g. 'Why did you use substitution instead of elimination here?' — not a generic question that could apply to any subject"
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

// ─── /api/analyze-expression ───────────────────────────────────────────────────
// Periodic (~30s) webcam snapshot analysis, logged only into the transcript for
// the admin report — never shown or spoken to the candidate. Deliberately scoped
// to a single, plain, professional behavioral observation (attentiveness/
// composure/engagement) rather than clinical or psychological claims, so this
// stays a lightweight qualitative aid rather than an automated "emotion
// detection" system.
app.post('/api/analyze-expression', async (req, res) => {
  try {
    const { imageBase64, stageLabel } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.3, maxOutputTokens: 80, thinkingConfig: { thinkingBudget: 0 } }
    });

    const promptText = `You are jotting a brief, professional observation note from a single webcam snapshot taken during a job interview (current stage: ${stageLabel || 'Interview'}).

Describe only plainly visible, behavioral cues relevant to engagement in an interview — e.g. eye contact/attentiveness, posture, composure, whether they appear actively engaged or distracted. Keep it to ONE short, neutral sentence.

Do NOT: diagnose or speculate about emotional/mental state, health, or personal characteristics; make any claims about age, gender, ethnicity, or other protected characteristics; use clinical or psychological language. If the frame is blank, unclear, or no face is visible, say so plainly instead of guessing.

Respond with ONLY the one-sentence observation, no preamble, no markdown.`;

    const data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const parts = [{ text: promptText }, { inlineData: { mimeType: 'image/jpeg', data } }];

    const result = await model.generateContent(parts);
    const notes = result.response.text().trim();

    res.json({ success: true, notes });
  } catch (err) {
    console.error('[/api/analyze-expression]', err.message);
    res.status(500).json({ error: 'Could not analyse frame', details: err.message });
  }
});

// ─── /api/report ──────────────────────────────────────────────────────────────
app.post('/api/report', async (req, res) => {
  try {
    const { transcript, teacherName, subject, problemScore, misconductCount = 0, endedForMisconduct = false } = req.body;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.5, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } }
    });

    // A candidate warned once or twice who then behaved appropriately is NOT
    // held against them — only an interview actually terminated for repeated
    // misconduct gets flagged. The transcript's "Conduct Flag" entries are kept
    // either way (full audit trail for a human reviewer), but the model must be
    // told explicitly not to penalize mere warnings that didn't escalate.
    const conductBlock = endedForMisconduct
      ? `\nCONDUCT FLAG: This interview was ended early because the candidate repeatedly used
abusive/inappropriate language or gave triggering responses despite warnings (see "Conduct
Flag" entries in the transcript below). This should weigh negatively on the recommendation,
and "summary" must explicitly mention that the interview was ended for conduct.\n`
      : (misconductCount > 0
          ? `\nNOTE: The transcript below contains "Conduct Flag" entries from earlier in the
interview where the candidate was warned once or twice about language/tone, but the interview
completed normally afterward. Do NOT let this affect overallScore, the category scores, the
recommendation, or the summary — evaluate the candidate purely on the substance of their actual
answers, exactly as you would if those entries weren't there.\n`
          : '');

    const prompt = `Generate a thorough, fair evaluation report for ${teacherName}, a ${subject} teacher, based on their interview.

FULL INTERVIEW TRANSCRIPT:
${transcript}

Problem-Solving Score: ${problemScore}/10
${conductBlock}
The transcript above may contain periodic "Camera Analysis" entries — brief, plain
behavioral observations noted from webcam snapshots taken every ~30 seconds
throughout the interview. Use these only to inform "engagementNotes" below; do not
let them influence overallScore or the category scores.

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
  "recommendation": "Highly Recommended | Recommended | Needs Improvement | Not Recommended",
  "engagementNotes": "1-2 plain sentences summarising overall visible engagement/composure across the Camera Analysis entries in the transcript, or null if the transcript has none"
}`;

    // Generation/parsing is isolated in its own try — a transcript containing
    // genuinely severe abusive language (exactly the case that leads to
    // endedForMisconduct) is more likely to make the model refuse or reply with
    // prose instead of JSON. Without this fallback, that failure would mean NO
    // report is saved at all — silently losing the record for precisely the
    // candidates most likely to need one flagged.
    let reportData;
    try {
      const result = await model.generateContent(prompt);
      let raw = result.response.text().trim();
      raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      reportData = JSON.parse(raw);
    } catch (genErr) {
      console.error('[/api/report] generation/parse failed, saving fallback report:', genErr.message);
      reportData = {
        overallScore: 0,
        summary: endedForMisconduct
          ? 'This interview was ended early due to repeated inappropriate/abusive conduct. Automated scoring was unavailable for this transcript — please review the transcript manually.'
          : 'Automated report generation failed for this transcript — please review the transcript manually.',
        recommendation: endedForMisconduct ? 'Not Recommended' : 'Needs Improvement',
        categories: [],
        strengths: [],
        improvements: [],
        engagementNotes: null
      };
    }

    // Force-set rather than trust the model to include this: a conduct flag on a
    // hiring evaluation is too significant to depend on the model reliably
    // echoing it back, so it's set directly from what the client tracked.
    // Only an interview actually ended for misconduct is flagged — a candidate
    // warned once or twice who then behaved appropriately is not held against them.
    reportData.conductFlagged = !!endedForMisconduct;
    reportData.misconductCount = misconductCount;

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
