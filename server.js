require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { WebSocketServer, WebSocket: SarvamWs } = require('ws');
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

// ─── Sarvam AI Voice (STT + TTS) ──────────────────────────────────────────────
// Optional cloud voice stack: Saarika (speech-to-text) + Bulbul (text-to-speech)
// via api.sarvam.ai, proxied through these routes so the API key never reaches
// the browser. Without SARVAM_API_KEY the client falls back to the browser Web
// Speech API (see public/voice.js) — the interview still works, just with the
// old browser-dependent voices and recognition.
const SARVAM_API_KEY = process.env.SARVAM_API_KEY || '';
const SARVAM_BASE_URL = 'https://api.sarvam.ai';
const SARVAM_STT_MODEL = process.env.SARVAM_STT_MODEL || 'saarika:v2.5';
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL || 'bulbul:v3';
// NOTE: speaker rosters differ per Bulbul version — 'priya' is a bulbul:v3
// voice; bulbul:v2 uses a different set (anushka, manisha, vidya, ...). A
// speaker/model mismatch is caught by the auto-pin fallback below.
const SARVAM_TTS_SPEAKER = process.env.SARVAM_TTS_SPEAKER || 'priya';

// Language codes Saarika accepts directly; anything else is sent as 'unknown'
// so it auto-detects instead of erroring on an unexpected code.
const SARVAM_STT_LANGS = new Set([
  'en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'mr-IN',
  'bn-IN', 'kn-IN', 'ml-IN', 'gu-IN', 'pa-IN', 'od-IN'
]);

// If the configured model/speaker is rejected by the API (e.g. a version name
// this account doesn't have yet), retry once with the known-stable pair and pin
// that for the rest of the process — one bad env value must not silently
// degrade every interview to browser voices.
let sarvamTtsPinned = null;      // { model, speaker } once a fallback succeeds
let sarvamSttPinnedModel = null; // model string once a fallback succeeds

// In-memory LRU of synthesized audio, keyed by model|speaker|text. Interview
// scripts repeat a lot of lines across candidates (stage openers, "Thank you
// for sharing your approach.", conduct warnings), and the client prefetches
// known-upcoming lines — cache hits make those start instantly and cost
// nothing against the Sarvam quota.
const ttsAudioCache = new Map(); // key -> base64 WAV
const TTS_AUDIO_CACHE_MAX = 300; // ~100-200KB per entry → tens of MB ceiling

async function sarvamTtsChunk(text) {
  let model = sarvamTtsPinned ? sarvamTtsPinned.model : SARVAM_TTS_MODEL;
  let speaker = sarvamTtsPinned ? sarvamTtsPinned.speaker : SARVAM_TTS_SPEAKER;

  const cacheKey = () => `${model}|${speaker}|${text}`;
  const hit = ttsAudioCache.get(cacheKey());
  if (hit) {
    // Refresh recency (Map iterates in insertion order, oldest first).
    ttsAudioCache.delete(cacheKey());
    ttsAudioCache.set(cacheKey(), hit);
    return hit;
  }

  const attempt = () => fetch(`${SARVAM_BASE_URL}/text-to-speech`, {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Exactly one of 'text'/'inputs' may be sent — the API rejects both
      // together, and 'inputs' is the deprecated spelling.
      text,
      target_language_code: 'en-IN', // the AI interviewer always speaks English
      model,
      speaker,
      enable_preprocessing: true // normalizes numbers/mixed English for natural reading
    })
  });

  let resp = await attempt();
  if (!resp.ok) {
    // Read the body exactly once — a Response body can't be read twice.
    const errBody = await resp.text().catch(() => '');
    const canRetry = !sarvamTtsPinned && [400, 404, 422].includes(resp.status)
      && !(model === 'bulbul:v2' && speaker === 'anushka');
    if (!canRetry) throw new Error(`Sarvam TTS ${resp.status}: ${errBody.slice(0, 300)}`);

    const rejectedPair = `${model}/${speaker}`;
    model = 'bulbul:v2';
    speaker = 'anushka';
    const retry = await attempt();
    if (!retry.ok) throw new Error(`Sarvam TTS ${resp.status}: ${errBody.slice(0, 300)}`);
    sarvamTtsPinned = { model, speaker };
    console.warn(`[sarvam-tts] ${rejectedPair} rejected (${resp.status} ${errBody.slice(0, 200)}) — pinned to bulbul:v2/anushka`);
    resp = retry;
  }

  const data = await resp.json();
  const audio = Array.isArray(data.audios) ? data.audios[0] : data.audio;
  if (!audio) throw new Error('Sarvam TTS returned no audio');

  ttsAudioCache.set(cacheKey(), audio); // model/speaker here reflect what was actually used
  if (ttsAudioCache.size > TTS_AUDIO_CACHE_MAX) {
    ttsAudioCache.delete(ttsAudioCache.keys().next().value);
  }
  return audio; // base64 WAV
}

// Bulbul caps each request at ~500 characters, so longer replies are split on
// sentence boundaries and synthesized as an ordered list of audio chunks the
// client plays back-to-back (mirroring how the browser engine already chunks).
function splitTtsChunks(text, maxLen = 450) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + ' ' + s).trim().length > maxLen && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += ' ' + s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  // Hard-slice any single sentence that alone exceeds the cap.
  return chunks.flatMap(c => {
    const out = [];
    for (let i = 0; i < c.length; i += maxLen) out.push(c.slice(i, i + maxLen));
    return out;
  });
}

// Tells the client at startup which voice engines to use — no key material,
// just a capability flag.
app.get('/api/voice-config', (req, res) => {
  res.json({ sarvam: !!SARVAM_API_KEY });
});

app.post('/api/tts', async (req, res) => {
  try {
    if (!SARVAM_API_KEY) return res.status(503).json({ error: 'Sarvam TTS not configured' });
    const chunks = splitTtsChunks(req.body && req.body.text);
    if (!chunks.length) return res.status(400).json({ error: 'text is required' });

    const audios = await Promise.all(chunks.map(sarvamTtsChunk));
    res.json({ success: true, audios });
  } catch (err) {
    console.error('[/api/tts]', err.message);
    res.status(502).json({ error: 'TTS failed', details: err.message });
  }
});

// Body is the raw WAV the client recorded (see voice.js encodeWav) — forwarded
// to Saarika as multipart form data.
app.post('/api/stt', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '30mb' }), async (req, res) => {
  try {
    if (!SARVAM_API_KEY) return res.status(503).json({ error: 'Sarvam STT not configured' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty audio' });
    }

    const lang = String(req.query.lang || 'en-IN');
    const attempt = (model) => {
      const form = new FormData();
      form.append('file', new Blob([req.body], { type: req.headers['content-type'] || 'audio/wav' }), 'audio.wav');
      form.append('model', model);
      form.append('language_code', SARVAM_STT_LANGS.has(lang) ? lang : 'unknown');
      return fetch(`${SARVAM_BASE_URL}/speech-to-text`, {
        method: 'POST',
        headers: { 'api-subscription-key': SARVAM_API_KEY },
        body: form
      });
    };

    let resp = await attempt(sarvamSttPinnedModel || SARVAM_STT_MODEL);
    if (!resp.ok && !sarvamSttPinnedModel && [400, 404, 422].includes(resp.status) && SARVAM_STT_MODEL !== 'saarika:v2') {
      const errBody = await resp.text().catch(() => '');
      const retry = await attempt('saarika:v2');
      if (retry.ok) {
        sarvamSttPinnedModel = 'saarika:v2';
        console.warn(`[sarvam-stt] ${SARVAM_STT_MODEL} rejected (${resp.status} ${errBody.slice(0, 200)}) — pinned to saarika:v2`);
        resp = retry;
      }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Sarvam STT ${resp.status}: ${body.slice(0, 300)}`);
    }

    const data = await resp.json();
    res.json({
      success: true,
      transcript: String(data.transcript || '').trim(),
      languageCode: data.language_code || null
    });
  } catch (err) {
    console.error('[/api/stt]', err.message);
    res.status(502).json({ error: 'STT failed', details: err.message });
  }
});

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

// ─── Interview Recordings ─────────────────────────────────────────────────────
// The candidate's browser records the whole interview (camera + mic) with
// MediaRecorder and streams it here in ~10s chunks (see public/recorder.js),
// appended in order to data/recordings/<id>.<ext>. The finished file is linked
// to the report via recordingId and only ever served back through the
// password-protected admin endpoint below.
//
// The container is webm everywhere EXCEPT iOS Safari, which has no webm
// MediaRecorder support at all and produces mp4 instead — recorder.js detects
// this client-side and tells us which extension to use via ?ext=, so an
// iOS-recorded interview doesn't get silently saved as a broken .webm file.
const RECORDINGS_DIR = path.join(__dirname, 'data', 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Client-generated crypto.randomUUID() — validated strictly since it becomes
// part of a filename.
const RECORDING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORDING_EXTS = ['webm', 'mp4'];

// A recording's extension is fixed for its whole session (set by the first
// chunk) — later chunks find the existing file regardless of what ?ext= they
// carry, so a client sending an unexpected value mid-stream never splits one
// recording across two files.
function findRecordingFile(id) {
  for (const ext of RECORDING_EXTS) {
    const p = path.join(RECORDINGS_DIR, `${id}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.post('/api/recording/chunk', express.raw({ type: 'application/octet-stream', limit: '25mb' }), (req, res) => {
  const id = String(req.query.id || '');
  if (!RECORDING_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid recording id' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Empty chunk' });
  }
  const ext = RECORDING_EXTS.includes(req.query.ext) ? req.query.ext : 'webm';
  const file = findRecordingFile(id) || path.join(RECORDINGS_DIR, `${id}.${ext}`);
  fs.appendFileSync(file, req.body);
  res.json({ success: true });
});

app.get('/api/admin/recordings/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '');
  if (!RECORDING_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid recording id' });
  const file = findRecordingFile(id);
  if (!file) return res.status(404).json({ error: 'Recording not found' });
  res.sendFile(file); // sets video/webm or video/mp4 from the real extension, honors Range requests
});

// ─── Problem-Solving Question Bank ────────────────────────────────────────────
// Real JEE/NEET questions (Mathematics, Physics, Chemistry, Biology) generated
// from the raw PYQ dumps by scripts/build-question-bank.js. Loaded once at
// startup and served by /api/problem-questions for the whiteboard rounds.
// Subjects not in the bank (Computer Science, English) — or a missing bank
// file — are handled client-side by falling back to the small built-in
// QUESTIONS_DB in public/questions.js.
const QUESTION_BANK_PATH = path.join(__dirname, 'data', 'question-bank.json');
const questionBank = {}; // subject -> array of bank entries

try {
  const { questions } = JSON.parse(fs.readFileSync(QUESTION_BANK_PATH, 'utf8'));
  for (const q of questions) {
    (questionBank[q.subject] = questionBank[q.subject] || []).push(q);
  }
  console.log(`📚 Question bank loaded: ${questions.length} questions (${Object.entries(questionBank).map(([s, a]) => `${s}: ${a.length}`).join(', ')})`);
} catch (err) {
  console.warn('⚠️  data/question-bank.json not found or unreadable — problem-solving rounds will use the built-in question set. Run: node scripts/build-question-bank.js');
}

// `count` distinct random picks, preferring Medium difficulty (the 90-second
// whiteboard window suits medium-depth problems) and topping up from the rest
// of the pool only if there aren't enough Medium questions.
function pickBankQuestions(pool, count) {
  const sample = (arr, n) => {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  };

  const medium = pool.filter(q => q.difficulty === 'Medium');
  const picked = sample(medium, Math.min(count, medium.length));
  if (picked.length < count) {
    const rest = pool.filter(q => q.difficulty !== 'Medium');
    picked.push(...sample(rest, count - picked.length));
  }
  return picked;
}

// Shapes a bank entry into exactly what the whiteboard UI already renders
// (same fields as questions.js entries). MCQ options are folded into the
// question HTML; answer + official solution travel only inside evalContext,
// which the candidate never sees — it grounds the AI evaluator.
function toClientQuestion(q) {
  const optionsHtml = q.options.length
    ? '<ol class="q-options" type="A">' + q.options.map(o => `<li>${o}</li>`).join('') + '</ol>'
    : '';

  const evalContext = [
    `This is a real ${q.exam}${q.year ? ' ' + q.year : ''} exam question${q.options.length ? ' with multiple-choice options (labelled A onward in the order shown)' : ''}.`,
    `Correct answer: ${q.answer}`,
    q.solution ? `Official solution (ground truth): ${q.solution}` : null
  ].filter(Boolean).join('\n');

  return {
    id: q.id,
    topic: q.topic,
    difficulty: q.difficulty,
    subject: q.subject,
    hasDiagram: false,
    question: q.question + optionsHtml,
    evalContext,
    // Numericals/derivations: the evaluator grades the full step-by-step
    // approach, not just the final answer (see /api/evaluate).
    requiresWork: !!q.requiresWork
  };
}

app.get('/api/problem-questions', (req, res) => {
  const subject = String(req.query.subject || '');
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 3, 1), 10);

  const pool = questionBank[subject];
  if (!pool || !pool.length) {
    return res.status(404).json({ error: `No bank questions for subject "${subject}"` });
  }

  res.json({ questions: pickBankQuestions(pool, count).map(toClientQuestion) });
});

// Best-effort scrub of LaTeX/markup out of text that will be spoken by TTS and
// shown as plain chat text (the problem-solving follow-up question). The prompt
// already forbids LaTeX there, but models leak it occasionally — this turns
// e.g. "O$_{2}^{2-}$" into "O2 2-" and "\frac{u^2}{2g}" into "(u 2 over 2g)"
// rather than letting raw markup reach the candidate's ears/screen.
function stripLatexForSpeech(text) {
  if (!text) return text;
  let t = String(text);
  // \frac{a}{b} → (a over b); run a few passes for (rare) nesting
  for (let i = 0; i < 3; i++) {
    t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1 over $2)');
  }
  t = t
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, 'square root of $1')
    .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\times|\\cdot/g, ' times ')
    .replace(/\\rightarrow|\\to|\\longrightarrow/g, ' gives ')
    .replace(/\\leq?\b/g, ' less than or equal to ')
    .replace(/\\geq?\b/g, ' greater than or equal to ')
    .replace(/\^\{?\\circ\}?|\\degree/g, ' degrees')
    // superscripts/subscripts: ^{2-} → " 2-", _{2} → "2", x^2 → "x 2"
    .replace(/\^\{([^{}]*)\}/g, ' $1')
    .replace(/_\{([^{}]*)\}/g, '$1')
    .replace(/\^([A-Za-z0-9+\-])/g, ' $1')
    .replace(/_([A-Za-z0-9+\-])/g, '$1')
    // any remaining \command → its bare name (e.g. \pi → pi, \theta → theta)
    .replace(/\\([A-Za-z]+)/g, '$1')
    // delimiters and leftover braces
    .replace(/\$\$?/g, '')
    .replace(/\\[\[\]()]/g, '')
    .replace(/[{}]/g, '');
  return t.replace(/\s{2,}/g, ' ').trim();
}

// ─── /api/evaluate ────────────────────────────────────────────────────────────
app.post('/api/evaluate', async (req, res) => {
  try {
    const { question, subject, imageBase64, dictatedText, evalContext, requiresWork } = req.body;

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
      generationConfig: { temperature: 0.4, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } }
    });

    let solutionDescription = '';
    if (imageBase64) {
      solutionDescription += `The teacher wrote their working by hand on a whiteboard, shown in the attached image. Read the handwriting carefully and evaluate the mathematical steps shown.\n`;
    }
    if (dictatedText) {
      solutionDescription += `The teacher also gave this spoken explanation of their solution (transcribed):\n"${dictatedText}"\n`;
    }

    const evalContextBlock = evalContext
      ? `\nGROUND TRUTH (for your evaluation only — the candidate never sees this; it supplies the correct answer/official solution, or for diagram questions, what the diagram showed):\n${evalContext}\n`
      : '';

    // Numericals/derivations (Maths, Physics, Chemistry) are graded on the
    // candidate's ENTIRE approach — method choice, setup, intermediate steps,
    // units, and the final answer — never on the final answer alone. This is a
    // teacher-competency interview: how they get there is what's being hired.
    const approachRubric = requiresWork
      ? `
This problem requires full detailed working, so evaluate the candidate's ENTIRE approach step by step, not just the final answer:
- Method/formula choice: did they pick a correct and sensible method for this problem?
- Setup and substitution: correct equations, correct values/signs/units carried in?
- Intermediate steps: is the chain of reasoning visible, ordered, and mathematically valid?
- Final answer: correct value/option, with units or simplification where applicable.

CRITICAL — evaluate ONLY what is actually present in the whiteboard image and/or the transcribed explanation. Never credit a step the candidate did not explicitly show or say: knowing what the correct derivation WOULD be is not evidence they did it. Fill in "workShown" first, strictly from the submission, then score only that.

Scoring rubric (apply strictly):
- If "workShown" is "none — final answer only", the score MUST be 4 or lower even if the answer is correct — for a teacher, an unexplained answer is a real weakness.
- A sound, clearly-shown method with a small arithmetic/sign slip near the end scores 6-8.
- Full marks require both a correct, visible approach AND a correct final answer.
- A wrong method that happens to land on the right answer must be scored on the method, not the answer.
In "evaluation", name the specific step(s) that were done well or went wrong (e.g. "correct energy-conservation setup, but the mass was substituted in grams instead of kilograms").
`
      : '';

    // The follow-up is read aloud by a text-to-speech voice and shown as plain
    // chat text — LaTeX or any notation ("O$_{2}^{2-}$", "\\frac{a}{b}") is
    // unreadable there, so it must be phrased entirely in spoken words.
    const followUpSpec = `One concise, ${subject}-specific question probing WHY they chose their particular approach or method, or a key step in their reasoning — e.g. 'Why did you use substitution instead of elimination here?' — not a generic question that could apply to any subject. CRITICAL: this question is spoken aloud by a text-to-speech voice and shown as plain text, so it must be plain conversational English with absolutely NO LaTeX, no $ or \\ symbols, no markup, and no sub/superscript notation — say any formula, ion, or expression in words instead (e.g. 'the O two two-minus ion', 'v squared equals u squared minus two g h')`;

    // For requiresWork problems, "workShown" is deliberately the FIRST field:
    // the model must extract what working is actually visible before it commits
    // to a score, which stops it crediting steps the candidate never showed.
    const jsonShape = requiresWork
      ? `{
  "workShown": "one sentence listing ONLY the solution steps actually visible in the submission — write exactly 'none — final answer only' if just an answer/option is given with no method",
  "evaluation": "2-3 sentence honest evaluation of the approach and correctness, naming the specific steps in their working that were right or wrong",
  "isCorrect": true,
  "score": 8,
  "feedback": "One constructive sentence on what could be improved",
  "followUpQuestion": "${followUpSpec}"
}`
      : `{
  "isCorrect": true,
  "score": 8,
  "evaluation": "2-3 sentence honest evaluation of correctness and quality",
  "feedback": "One constructive sentence on what could be improved",
  "followUpQuestion": "${followUpSpec}"
}`;

    const promptText = `You are evaluating a ${subject} teacher's solution to a problem, given under 90-second time pressure.

PROBLEM:
${question}
${evalContextBlock}${approachRubric}
${solutionDescription}
Evaluate the solution and respond ONLY with the exact JSON object below — no markdown fences, no prose before or after it. This applies even if the image is blank, illegible, or contains no relevant work: in that case still return the JSON with score 0 and explain why in the evaluation field. Never reply with plain text or an apology instead of the JSON.
${jsonShape}`;

    const parts = [{ text: promptText }];
    if (imageBase64) {
      const data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      parts.push({ inlineData: { mimeType: 'image/png', data } });
    }

    const result = await model.generateContent(parts);
    let raw = result.response.text().trim();
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const parsed = JSON.parse(raw);
    parsed.followUpQuestion = stripLatexForSpeech(parsed.followUpQuestion);
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
    const { transcript, teacherName, subject, problemScore, misconductCount = 0, endedForMisconduct = false, recordingId = null } = req.body;

    // Only attach a recording that actually exists on disk — a made-up id in
    // the request must not become a broken (or probing) link in the report.
    const recordingFile = (typeof recordingId === 'string' && RECORDING_ID_RE.test(recordingId))
      ? findRecordingFile(recordingId) : null;
    const safeRecordingId = recordingFile ? recordingId : null;
    const recordingExt = recordingFile ? path.extname(recordingFile).slice(1) : null;

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

    const submissionId = store.saveReport({ teacherName, subject, problemScore, transcript, report: reportData, recordingId: safeRecordingId, recordingExt });

    // The report itself is never sent back to the candidate's browser — it's
    // only retrievable later through the password-protected /admin dashboard.
    res.json({ success: true, submissionId });
  } catch (err) {
    console.error('[/api/report]', err.message);
    res.status(500).json({ error: 'Report generation failed', details: err.message });
  }
});

// ─── Sarvam streaming STT relay ───────────────────────────────────────────────
// Real-time transcription: the browser streams 16kHz PCM chunks over this
// WebSocket and gets Sarvam's per-utterance transcripts back as the candidate
// speaks (see voice.js). A dumb bidirectional relay — the client speaks
// Sarvam's own message protocol; this hop exists only to attach the API key,
// which must never reach the browser. Client-side batch STT (/api/stt) remains
// the fallback whenever this stream fails.
const SARVAM_STREAM_STT_MODEL = process.env.SARVAM_STREAM_STT_MODEL || 'saaras:v3';

function attachSttStreamRelay(server) {
  const wss = new WebSocketServer({ server, path: '/api/stt-stream' });
  wss.on('connection', (client, req) => {
    if (!SARVAM_API_KEY) {
      client.close(1011, 'Sarvam STT not configured');
      return;
    }
    const q = new URL(req.url, 'http://localhost').searchParams;
    const lang = SARVAM_STT_LANGS.has(q.get('lang')) ? q.get('lang') : 'unknown';

    const upstream = new SarvamWs(
      `wss://api.sarvam.ai/speech-to-text/ws?language-code=${lang}&model=${encodeURIComponent(SARVAM_STREAM_STT_MODEL)}`
        + '&mode=transcribe&sample_rate=16000&input_audio_codec=pcm_s16le&vad_signals=true',
      { headers: { 'api-subscription-key': SARVAM_API_KEY } }
    );

    // Audio arriving before the upstream socket opens is queued, not dropped.
    const queue = [];
    upstream.on('open', () => {
      for (const m of queue) upstream.send(m);
      queue.length = 0;
    });
    client.on('message', data => {
      const msg = data.toString();
      if (upstream.readyState === SarvamWs.OPEN) upstream.send(msg);
      else if (upstream.readyState === SarvamWs.CONNECTING) queue.push(msg);
    });
    upstream.on('message', data => {
      if (client.readyState === client.OPEN) client.send(data.toString());
    });

    const closeBoth = () => {
      try { client.close(); } catch (_) {}
      try { upstream.close(); } catch (_) {}
    };
    client.on('close', closeBoth);
    client.on('error', closeBoth);
    upstream.on('close', closeBoth);
    upstream.on('error', err => {
      console.error('[stt-stream] upstream error:', err.message);
      closeBoth();
    });
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  console.log('\n🎙️  Vedantu MT AI Interview');
  console.log(SARVAM_API_KEY
    ? `🗣️  Voice: Sarvam AI (streaming STT ${SARVAM_STREAM_STT_MODEL}, batch STT ${SARVAM_STT_MODEL}, TTS ${SARVAM_TTS_MODEL} · ${SARVAM_TTS_SPEAKER})`
    : '🗣️  Voice: browser Web Speech fallback — set SARVAM_API_KEY in .env to enable Sarvam STT/TTS');
  console.log(`🌐  http://localhost:${PORT}`);
  console.log('📋  Press Ctrl+C to stop\n');
});
attachSttStreamRelay(httpServer);
