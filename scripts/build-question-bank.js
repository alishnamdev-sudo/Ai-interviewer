// ─── Question Bank Builder ─────────────────────────────────────────────────────
// One-off (re-runnable) preprocessor that turns the raw JEE/NEET question dumps
// into the single compact bank the server reads at startup
// (data/question-bank.json) to power the problem-solving (whiteboard) rounds.
//
// Usage:
//   node scripts/build-question-bank.js [source1.json source2.json ...]
//
// With no arguments it uses the four known source dumps (see DEFAULT_SOURCES).
// The source files are NOT committed to the repo — only the generated bank is.
//
// The two source formats handled:
//   • "PDF_*" dumps    — { Question, Options, Answer: "…", Tags:[{Subject,Chapter,
//                          Difficulty}], year, exam, … } (answer is a string:
//                          either a bare letter or the full option text)
//   • "PYQs" dumps     — { Question, Options, Answer: ["A"], Solution, Type,
//                          Tags:[{Subject, Chapter, Difficulty}] } (HTML-rich,
//                          answer is an option letter in a 1-element array)
//
// A question is kept only if it can be rendered and graded fairly on the
// whiteboard screen: it must not depend on an image/figure/table we can't show,
// and it must carry a resolvable correct answer to ground the AI evaluator.

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCES = [
  'C:/Users/Alish/Downloads/PDF_NEET_Questions.json',
  'C:/Users/Alish/Downloads/PDF_JEE_Questions.json',
  'C:/Users/Alish/Downloads/NEET PYQs (2013-2026) (1).json',
  'C:/Users/Alish/Downloads/cmds_question_output_for_tests-20260630T151326Z-3-001/cmds_question_output_for_tests/JEE Main PYQs (2015-2026).json'
];

const OUT_FILE = path.join(__dirname, '..', 'data', 'question-bank.json');

// App subject names ← source subject names
const SUBJECT_MAP = {
  math: 'Mathematics', maths: 'Mathematics', mathematics: 'Mathematics',
  physics: 'Physics',
  chemistry: 'Chemistry',
  biology: 'Biology', botany: 'Biology', zoology: 'Biology'
};

const DIFFICULTY_MAP = {
  beginner: 'Easy', easy: 'Easy',
  medium: 'Medium', moderate: 'Medium',
  tough: 'Hard', hard: 'Hard', difficult: 'Hard'
};

// Question types that never work as a standalone whiteboard problem — they
// rely on tabular/matching layouts that rarely survive the PDF extraction.
const EXCLUDED_TYPES = /match|matching|arrange in sequence|assertion|fill-in|statement[- ]based/i;

// A question (or its options) referring to a figure/diagram/graph/table is
// unusable here: image-bearing questions are filtered out separately, so any
// remaining reference means the visual was lost in extraction.
const LOST_VISUAL_RE = /\b(figure|diagram|graph|flow ?chart|table|column\s*[-–]?\s*(I|II|1|2))\b/i;

// Option-less entries (numeric/free-response) are only trustworthy when the
// text actually reads like a task. The PDF dumps contain entries whose
// Question field is really a worked SOLUTION (screw-gauge calculations ending
// in "⇒ N = 200"), a truncated fragment, or an MCQ whose options were lost —
// none of which contain an imperative/interrogative cue.
const TASK_RE = /\?|\bfind\b|\bcalculate\b|\bdetermine\b|\bevaluate\b|\bprove\b|\bshow that\b|\bvalue of\b|\bequal to\b|\bequals\b|\bhow many\b|\bwhat\b|\bidentify\b|\bwrite\b|\bbalance\b|\bname\b|\bstate\b|\bderive\b|\bsolve\b|\bexpress\b|\bcompute\b|\bthen\b|\bis[\s:]*_+/i;
const SOLUTION_TEXT_RE = /\\Rightarrow|⇒|\\therefore|Hence,|So,|we get/;

function stripHtml(s) {
  return String(s || '')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#9;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Key used to spot the same question appearing in more than one dump.
function dedupeKey(questionText, options) {
  const norm = s => stripHtml(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(questionText) + '|' + norm(options[0] || '');
}

// Resolve the raw answer (letter, full option text, or numeric value) to a
// human-readable "correct answer" string for the evaluator. Returns null when
// the answer can't be trusted to identify a single option.
function resolveAnswer(rawAnswer, options) {
  let raw = Array.isArray(rawAnswer) ? rawAnswer[0] : rawAnswer;
  if (raw === undefined || raw === null) return null;
  raw = String(raw).trim();
  if (!raw) return null;

  if (!options.length) return raw; // numeric/free-response: the value IS the answer

  // Bare letter like "b", "(C)", "d." → map to the option at that index
  const letterMatch = raw.match(/^\(?\s*([a-eA-E])\s*[\).:]?$/);
  if (letterMatch) {
    const idx = letterMatch[1].toLowerCase().charCodeAt(0) - 97;
    if (idx < options.length) {
      return `Option (${String.fromCharCode(65 + idx)}): ${stripHtml(options[idx])}`;
    }
    return null;
  }

  // Full/partial option text — find which option it matches
  const normRaw = stripHtml(raw).toLowerCase().replace(/^\(?[a-e]\)?[\s.:-]*/, '').trim();
  if (!normRaw) return null;
  const idx = options.findIndex(o => {
    const normOpt = stripHtml(o).toLowerCase().replace(/^\(?[a-e]\)?[\s.:-]*/, '').trim();
    return normOpt === normRaw || (normOpt.length > 12 && (normOpt.includes(normRaw) || normRaw.includes(normOpt)));
  });
  if (idx >= 0) {
    return `Option (${String.fromCharCode(65 + idx)}): ${stripHtml(options[idx])}`;
  }

  // Doesn't match any option — keep the raw text only if it's substantial
  // enough to plausibly be the answer stated in its own words.
  return stripHtml(raw).length >= 3 ? stripHtml(raw) : null;
}

// Flags questions where the candidate's WHOLE approach must be evaluated —
// Maths/Physics/Chemistry numericals and derivations — as opposed to
// recall/conceptual MCQs where the chosen answer is the substance. The
// evaluator applies a step-by-step working rubric to flagged questions.
function needsDetailedWork(subject, questionText, options, tag) {
  if (subject === 'Biology') return false;      // NEET Biology is recall/concept MCQ
  if (!options.length) return true;             // numeric/free-response: working IS the answer
  if (/CALCULATION/i.test(String(tag.CognitiveLevel || ''))) return true;

  const plain = stripHtml(questionText);
  if (/\b(calculate|evaluate|find the|value of|how (much|many)|determine|is equal to)\b/i.test(plain)) return true;

  // Mostly-numeric options (e.g. "4.8 × 10⁻³ J", "$\frac{\pi}{12}$") mean the
  // question is a computation even if it isn't phrased with a calculation verb.
  const numericOpts = options.filter(o =>
    /^[\s$\\({\[]*[-+]?[\d.]/.test(stripHtml(o)) || /\\frac|\\sqrt|\^\{|×\s*10|\\times\s*10/.test(o)
  ).length;
  return numericOpts >= Math.ceil(options.length * 0.75);
}

function normalizeEntry(q, sourceLabel) {
  const tag = (Array.isArray(q.Tags) && q.Tags[0]) || {};

  const subject = SUBJECT_MAP[String(tag.Subject || q.subject || '').trim().toLowerCase()];
  if (!subject) return null;

  const questionText = String(q.Question || q.questionText || '').trim();
  let options = (q.Options || q.options || []).map(o => String(o).trim()).filter(Boolean);

  // Some dumps bake "(a) ", "(b) "… into each option; the UI renders options
  // as an A/B/C/D list already, so strip the prefixes to avoid double labels —
  // but only when EVERY option has one (a lone leading "(a)" might be content).
  const PREFIX_RE = /^\(?\s*[a-eA-E]\s*[\).]\s*/;
  if (options.length && options.every(o => PREFIX_RE.test(o))) {
    options = options.map(o => o.replace(PREFIX_RE, '').trim()).filter(Boolean);
  }

  if (stripHtml(questionText).length < 15) return null;
  if (stripHtml(questionText).length > 1500) return null;

  const blob = questionText + ' ' + options.join(' ');
  if (/<img/i.test(blob)) return null;
  if (LOST_VISUAL_RE.test(stripHtml(blob))) return null;

  const type = String(q.Type || q.type || '').trim();
  if (EXCLUDED_TYPES.test(type)) return null;

  // MCQs need at least 3 options to be a fair MCQ; anything with fewer is only
  // kept when it's a numeric/free-response question (no options at all).
  if (options.length > 0 && options.length < 3) return null;

  if (options.length === 0) {
    const plain = stripHtml(questionText);
    if (!TASK_RE.test(plain)) return null;
    if (SOLUTION_TEXT_RE.test(plain) && !plain.includes('?')) return null;
  }

  const answerText = resolveAnswer(q.Answer !== undefined ? q.Answer : q.correctAnswer, options);
  if (!answerText) return null;

  const difficulty = DIFFICULTY_MAP[String(tag.Difficulty || q.difficulty || '').trim().toLowerCase()] || 'Medium';

  let solution = stripHtml(q.Solution || q.solution || '');
  if (/not available/i.test(solution)) solution = '';
  if (solution.length > 900) solution = solution.slice(0, 900) + '…';

  const exam = /neet/i.test(String(q.exam || '') + sourceLabel) ? 'NEET' : 'JEE';

  return {
    subject,
    topic: String(tag.Chapter || q.chapter || tag.Topic || 'General').trim() || 'General',
    difficulty,
    exam,
    year: Number(q.year) || null,
    question: questionText,
    options,          // [] for numeric/free-response questions
    answer: answerText,
    solution: solution || null,
    requiresWork: needsDetailedWork(subject, questionText, options, tag),
    _key: dedupeKey(questionText, options)
  };
}

function main() {
  const sources = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SOURCES;

  const seen = new Set();
  const bank = [];
  const perSource = {};

  for (const src of sources) {
    if (!fs.existsSync(src)) {
      console.error(`⚠️  Source not found, skipping: ${src}`);
      continue;
    }
    const label = path.basename(src);
    const arr = JSON.parse(fs.readFileSync(src, 'utf8'));
    let kept = 0;

    for (const raw of arr) {
      const entry = normalizeEntry(raw, label);
      if (!entry) continue;
      if (seen.has(entry._key)) continue;
      seen.add(entry._key);
      delete entry._key;
      entry.id = `bank_${bank.length + 1}`;
      bank.push(entry);
      kept++;
    }
    perSource[label] = { total: arr.length, kept };
  }

  const bySubject = {};
  const byDifficulty = {};
  for (const q of bank) {
    bySubject[q.subject] = (bySubject[q.subject] || 0) + 1;
    byDifficulty[`${q.subject}/${q.difficulty}`] = (byDifficulty[`${q.subject}/${q.difficulty}`] || 0) + 1;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ questions: bank }));

  console.log('\n✅ Question bank written to', OUT_FILE);
  console.log('   Size:', (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2), 'MB');
  console.log('   Per source:', JSON.stringify(perSource, null, 2));
  console.log('   By subject:', JSON.stringify(bySubject, null, 2));
  console.log('   By subject/difficulty:', JSON.stringify(byDifficulty, null, 2));
}

main();
