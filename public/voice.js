/**
 * VoiceManager — speech input/output for the interview.
 *
 * Two engines behind one public surface, chosen at init() from the server's
 * /api/voice-config:
 *
 *  - Sarvam (preferred — used when the server has SARVAM_API_KEY): microphone
 *    audio is captured with WebAudio, WAV-encoded, and transcribed server-side
 *    by Sarvam Saarika (/api/stt); replies are spoken with Sarvam Bulbul
 *    (/api/tts). Gives a consistent Indian voice on every browser/OS and
 *    native recognition of the Indian languages offered at setup.
 *  - Browser (fallback): Web Speech API (SpeechRecognition + speechSynthesis)
 *    — free, but voice quality and language support depend entirely on the
 *    candidate's browser/OS (see pickBestVoice below for its limits).
 *
 * If Sarvam calls start failing mid-interview (network, quota), the affected
 * engine drops back to the browser one after MAX_ENGINE_FAILURES consecutive
 * failures rather than stalling the interview.
 */
const VoiceManager = (() => {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  // ── Engine selection ───────────────────────────────────────────────────────
  let sttEngine = 'browser'; // 'sarvam' | 'browser'
  let ttsEngine = 'browser';
  let sttFailures = 0;
  let ttsFailures = 0;
  const MAX_ENGINE_FAILURES = 2;

  // The candidate may speak in any of the setup languages; the AI always
  // answers back in Indian English regardless.
  let recognitionLang = 'en-IN';

  // ── Browser-engine state ───────────────────────────────────────────────────
  let recognition = null;
  let selectedVoice = null;
  let _isIndianVoice = false;
  let _cancelledByCaller = false;
  let dictationRecognition = null;
  let _browserTranscript = ''; // finals + interims accumulated by the current listen()

  // ── Shared state ───────────────────────────────────────────────────────────
  let _isListening = false;
  let _isSpeaking = false;
  let _isDictating = false;

  // ── Sarvam-engine state ────────────────────────────────────────────────────
  let micStream = null;
  let audioCtx = null;
  let _speakGen = 0;      // bumped to invalidate/cancel any in-flight Sarvam speech
  let _ttsAbort = null;   // aborts the in-flight /api/tts fetch
  let _ttsSource = null;  // AudioBufferSourceNode currently playing
  let cap = null;         // active answer-capture session { chunks, sampleRate, hadSpeech, capture }
  let dict = null;        // active dictation-capture session
  let _dictFlush = Promise.resolve(); // resolves once pending dictation transcriptions land

  // Frames quieter than this RMS count as silence for voice-activity detection
  // (the mic stream has browser noise suppression on, so ambient noise sits
  // well below this).
  const SPEECH_RMS_THRESHOLD = 0.012;
  const STT_SAMPLE_RATE = 16000; // speech needs no more; keeps uploads small

  // Dictation is transcribed in segments so text appears while they speak:
  // cut a segment at a natural pause once it's long enough, or force a cut
  // if they've been talking continuously for a long while.
  const DICT_MIN_SEGMENT_SEC = 6;
  const DICT_MAX_SEGMENT_SEC = 25;
  const DICT_CUT_SILENCE_SEC = 0.6;

  // ── Voice loading (browser TTS fallback) ──────────────────────────────────
  // Best-effort: prefer any voice that's actually Indian English. Browsers
  // only expose voices installed on the OS, so on most machines none of this
  // will match and we fall back to a generic English voice. (With the Sarvam
  // engine active this only matters if Sarvam TTS fails mid-interview.)
  function pickBestVoice(voices) {
    const preferred = [
      'Microsoft Neerja Online (Natural) - English (India)',
      'Microsoft Neerja (Natural) - English (India)',
      'Microsoft Neerja - English (India)',
      'Microsoft Prabhat Online (Natural) - English (India)',
      'Microsoft Heera - English (India)',
      'Microsoft Ravi - English (India)',
      'Google Indian English Female',
      'Google Indian English Male',
      'Rishi', // Apple's Indian English voice on recent iOS/macOS
    ];
    for (const name of preferred) {
      const v = voices.find(v => v.name === name);
      if (v) return v;
    }
    const enIN = voices.find(v => v.lang === 'en-IN' || v.lang === 'en_IN');
    if (enIN) return enIN;
    const namedIndia = voices.find(v => /india/i.test(v.name));
    if (namedIndia) return namedIndia;
    return voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0] || null;
  }

  function isVoiceIndian(voice) {
    if (!voice) return false;
    return /en[-_]in/i.test(voice.lang || '') || /india/i.test(voice.name || '');
  }

  function loadVoice() {
    return new Promise(resolve => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        selectedVoice = pickBestVoice(voices);
        _isIndianVoice = isVoiceIndian(selectedVoice);
        resolve();
      } else {
        window.speechSynthesis.addEventListener('voiceschanged', () => {
          selectedVoice = pickBestVoice(window.speechSynthesis.getVoices());
          _isIndianVoice = isVoiceIndian(selectedVoice);
          resolve();
        }, { once: true });
        // Timeout fallback in case voiceschanged never fires
        setTimeout(resolve, 1500);
      }
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  // lang: BCP-47 code for the language the CANDIDATE will speak in
  // (e.g. 'en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'mr-IN'), fixed for the
  // interview based on what they picked at setup. Async because it asks the
  // server which voice engines are available.
  async function init(lang) {
    recognitionLang = lang || 'en-IN';

    let sarvamAvailable = false;
    try {
      const res = await fetch('/api/voice-config');
      sarvamAvailable = !!(res.ok && (await res.json()).sarvam);
    } catch (_) { /* server unreachable — fall through to browser engines */ }

    const mediaOk = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      && (window.AudioContext || window.webkitAudioContext));

    if (sarvamAvailable && mediaOk) {
      sttEngine = 'sarvam';
      ttsEngine = 'sarvam';
      // Created here, inside the "Begin Interview" click gesture, so the
      // context starts unlocked and later playback never hits the browser's
      // autoplay policy.
      ensureCtx();
    } else {
      sttEngine = 'browser';
      ttsEngine = 'browser';
    }

    // Browser recognition doubles as the runtime fallback for Sarvam STT, so
    // set it up whenever the API exists — it's only *required* in browser mode.
    if (SpeechRecognition) initBrowserRecognition();
    else if (sttEngine === 'browser') return { supported: false };

    return { supported: true };
  }

  function initBrowserRecognition() {
    recognition = new SpeechRecognition();
    // continuous:true so Chrome doesn't silently auto-stop after its own short
    // internal "no speech" timeout — we decide when to give up, not the browser.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = recognitionLang;
    recognition.maxAlternatives = 1;
  }

  // ── WebAudio capture plumbing (Sarvam engine) ─────────────────────────────
  function ensureCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  async function ensureMic() {
    if (micStream && micStream.active) return micStream;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    return micStream;
  }

  function releaseMic() {
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
  }

  // Streams mono Float32 frames (~256ms each) from the mic to onFrame.
  function startCapture(stream, onFrame) {
    const ctx = ensureCtx();
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    // ScriptProcessor only runs while connected to the destination — route it
    // through a zero-gain node so nothing is audibly echoed back.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.onaudioprocess = e => {
      // The underlying buffer is reused by the engine — copy it.
      onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    return {
      sampleRate: ctx.sampleRate,
      stop() {
        processor.onaudioprocess = null;
        try { source.disconnect(); processor.disconnect(); sink.disconnect(); } catch (_) {}
      }
    };
  }

  function frameRms(f32) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    return Math.sqrt(sum / f32.length);
  }

  // Downsamples captured Float32 frames to 16kHz mono 16-bit PCM.
  function downsamplePcm16(chunks, fromRate) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const all = new Float32Array(len);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }

    const ratio = fromRate / STT_SAMPLE_RATE;
    const outLen = Math.floor(all.length / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      // Average the source samples covered by this output sample — a cheap
      // low-pass that avoids the worst aliasing of plain decimation.
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), all.length);
      let sum = 0, n = 0;
      for (let j = start; j < end; j++) { sum += all[j]; n++; }
      const v = Math.max(-1, Math.min(1, n ? sum / n : 0));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
    }
    return pcm;
  }

  function pcm16ToBase64(pcm) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.length * 2);
    let bin = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(bin);
  }

  // Wraps the downsampled PCM in a WAV header Saarika's REST API accepts.
  function encodeWav(chunks, fromRate) {
    const pcm = downsamplePcm16(chunks, fromRate);
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, STT_SAMPLE_RATE, true);
    view.setUint32(28, STT_SAMPLE_RATE * 2, true); // byte rate
    view.setUint16(32, 2, true);  // block align
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data'); view.setUint32(40, pcm.length * 2, true);
    new Int16Array(buffer, 44).set(pcm);
    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function sarvamTranscribe(blob) {
    const res = await fetch(`/api/stt?lang=${encodeURIComponent(recognitionLang)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: blob
    });
    if (!res.ok) throw new Error('STT request failed: ' + res.status);
    const data = await res.json();
    return String(data.transcript || '').trim();
  }

  // ── Speech Synthesis ───────────────────────────────────────────────────────
  function splitIntoChunks(text, maxLen = 200) {
    if (text.length <= maxLen) return [text];
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    const chunks = [];
    let current = '';
    for (const s of sentences) {
      if ((current + s).length > maxLen && current.length > 0) {
        chunks.push(current.trim());
        current = s;
      } else {
        current += ' ' + s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(c => c.length > 0);
  }

  // Optional hook fired while speaking: receives the cumulative number of
  // words spoken so far across the current line (Infinity = line finished or
  // interrupted — reveal everything). The app uses this to reveal the AI
  // bubble's text word-by-word in sync with the audio.
  let progressHook = null;
  function setProgressHook(fn) { progressHook = fn; }
  function emitProgress(n) {
    if (progressHook) { try { progressHook(n); } catch (_) {} }
  }

  function speak(text, onEnd, onError) {
    if (!text || text.trim().length === 0) {
      if (onEnd) onEnd();
      return;
    }
    // A fresh speak() supersedes anything still in flight — its onEnd (if any)
    // must not fire once we've moved on. cancelSpeech (not stopSpeaking) so the
    // NEW line's just-rendered bubble isn't snapped to fully-revealed.
    cancelSpeech();
    _cancelledByCaller = false;

    if (ttsEngine === 'sarvam') sarvamSpeak(text.trim(), onEnd, onError);
    else browserSpeak(text.trim(), onEnd, onError);
  }

  // Sentence-group size used for pipelined Sarvam TTS. Smaller groups mean the
  // first audio arrives sooner (only the first group must be synthesized before
  // speech starts).
  const TTS_CHUNK_CHARS = 160;

  // How a line is divided for Sarvam synthesis: the FIRST sentence always goes
  // alone (synthesis time scales with length, so a short first group minimizes
  // time-to-first-word), and the rest are grouped up to TTS_CHUNK_CHARS.
  // prefetch() and sarvamSpeak() MUST share this or cache keys won't match.
  function ttsGroups(text) {
    const clean = String(text).trim();
    if (!clean) return [];
    const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
    const first = sentences.shift().trim();
    const rest = sentences.length
      ? splitIntoChunks(sentences.join(' ').trim(), TTS_CHUNK_CHARS)
      : [];
    return [first, ...rest].filter(c => c && c.trim());
  }

  // Client-side cache: sentence-chunk text -> Promise<string[] base64 WAVs>.
  // Holds prefetched lines (resume questions, canned acks) and recently spoken
  // ones so repeats start instantly.
  const ttsCache = new Map();
  const TTS_CACHE_MAX = 40;

  function getTtsAudios(text, signal) {
    if (ttsCache.has(text)) return ttsCache.get(text);
    const p = fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal
    })
      .then(r => {
        if (!r.ok) throw new Error('TTS request failed: ' + r.status);
        return r.json();
      })
      .then(data => {
        const audios = (data.audios || []).filter(Boolean);
        if (!audios.length) throw new Error('empty TTS response');
        return audios;
      });
    ttsCache.set(text, p);
    p.catch(() => ttsCache.delete(text)); // never cache a failure/abort
    if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
    return p;
  }

  // Warm the TTS cache for a line that will be spoken soon (no-op for the
  // browser engine, which has no synthesis latency to hide).
  function prefetch(text) {
    if (ttsEngine !== 'sarvam' || !text || !text.trim()) return;
    ttsGroups(text).forEach(chunk => {
      getTtsAudios(chunk).catch(() => {}); // failures fall out of the cache; speak() will retry
    });
  }

  function sarvamSpeak(text, onEnd, onError) {
    const gen = _speakGen; // cancelSpeech() above set the current generation
    _isSpeaking = true;
    _ttsAbort = new AbortController();

    // Pipelined: request every sentence group up front in parallel, then play
    // them in order as they arrive — speech starts once only the FIRST short
    // group is synthesized, instead of after the whole reply.
    const groups = ttsGroups(text);
    const pending = groups.map(chunk => getTtsAudios(chunk, _ttsAbort.signal));

    (async () => {
      let spokeAnything = false;
      let baseWords = 0;
      try {
        for (let gi = 0; gi < pending.length; gi++) {
          const audios = await pending[gi];
          if (gen !== _speakGen) return; // superseded/cancelled while fetching
          ttsFailures = 0;
          const groupWords = groups[gi].trim().split(/\s+/).length;
          // A group ≤TTS_CHUNK_CHARS comes back as one audio in practice; if
          // the server ever sub-chunks, spread the words evenly across clips.
          const perAudio = Math.ceil(groupWords / audios.length);
          let allocated = 0;
          for (const b64 of audios) {
            const words = Math.min(perAudio, groupWords - allocated);
            await playOneAudio(b64, gen, { words, baseWords: baseWords + allocated });
            if (gen !== _speakGen) return;
            allocated += words;
            spokeAnything = true;
          }
          baseWords += groupWords;
          emitProgress(baseWords); // snap to the group boundary
        }
        _isSpeaking = false;
        _ttsSource = null;
        emitProgress(Infinity);
        if (onEnd) onEnd();
      } catch (e) {
        if (gen !== _speakGen) return; // deliberate cancel — stay silent
        console.warn('Sarvam TTS failed, falling back to browser voice:', e.message || e);
        if (++ttsFailures >= MAX_ENGINE_FAILURES) ttsEngine = 'browser';
        if (spokeAnything) {
          // Part of the line was already spoken — don't restart it in the
          // browser voice; just end the turn normally.
          _isSpeaking = false;
          _ttsSource = null;
          emitProgress(Infinity);
          if (onEnd) onEnd();
        } else {
          browserSpeak(text, onEnd, onError);
        }
      }
    })();
  }

  // Decodes and plays one base64 WAV through WebAudio (the context was
  // unlocked during init's click gesture, so this is autoplay-safe).
  // Resolves when playback ends, is cancelled, or the chunk is undecodable.
  // reveal: { words, baseWords } — emits word-progress evenly across the
  // clip's duration (Bulbul returns no word timestamps, but an even spread
  // over a short sentence group tracks the real cadence closely).
  function playOneAudio(b64, gen, reveal) {
    return new Promise(resolve => {
      const ctx = ensureCtx();
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      ctx.decodeAudioData(bytes.buffer)
        .then(buf => {
          if (gen !== _speakGen) return resolve();
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);

          let revealTimer = null;
          if (reveal && reveal.words > 0) {
            let shown = 1;
            emitProgress(reveal.baseWords + 1); // first word appears as audio starts
            if (reveal.words > 1) {
              const wordMs = (buf.duration * 1000) / reveal.words;
              revealTimer = setInterval(() => {
                if (gen !== _speakGen || shown >= reveal.words) {
                  clearInterval(revealTimer);
                  return;
                }
                shown++;
                emitProgress(reveal.baseWords + shown);
              }, wordMs);
            }
          }

          src.onended = () => {
            if (revealTimer) clearInterval(revealTimer);
            resolve(); // also fires on stopSpeaking()'s stop()
          };
          _ttsSource = src;
          src.start();
        })
        .catch(() => resolve()); // skip an undecodable chunk
    });
  }

  function browserSpeak(text, onEnd, onError) {
    _isSpeaking = true;

    const chunks = splitIntoChunks(text);
    let idx = 0;
    let baseWords = 0;

    function speakNext() {
      if (idx >= chunks.length) {
        _isSpeaking = false;
        emitProgress(Infinity);
        if (onEnd) onEnd();
        return;
      }
      const chunkText = chunks[idx];
      const chunkWords = chunkText.trim().split(/\s+/).length;
      const utt = new SpeechSynthesisUtterance(chunkText);
      utt.rate = 0.92;
      utt.pitch = 1.05;
      utt.volume = 1.0;
      // Hints Indian English to the engine even when falling back to a
      // non-Indian voice — some engines use this for pronunciation.
      utt.lang = 'en-IN';
      if (selectedVoice) utt.voice = selectedVoice;

      // Word-progress: prefer real boundary events (local voices fire them
      // with accurate charIndex); network voices often don't, so an estimator
      // (~140wpm at this rate) paces the reveal until a boundary proves the
      // engine supports the real thing.
      let boundarySeen = false;
      let estShown = 0;
      let estTimer = setInterval(() => {
        if (boundarySeen || _cancelledByCaller) { clearInterval(estTimer); estTimer = null; return; }
        if (estShown < chunkWords) { estShown++; emitProgress(baseWords + estShown); }
      }, 430);
      const clearEst = () => { if (estTimer) { clearInterval(estTimer); estTimer = null; } };

      utt.onboundary = e => {
        if (e.name && e.name !== 'word') return;
        boundarySeen = true;
        clearEst();
        const before = chunkText.slice(0, e.charIndex).trim();
        const spoken = before ? before.split(/\s+/).length : 0;
        // The boundary fires as a word STARTS — reveal that word too.
        emitProgress(baseWords + Math.min(spoken + 1, chunkWords));
      };

      utt.onend = () => {
        clearEst();
        // Some browsers (notably Chrome) fire 'end' rather than 'error' when an
        // utterance is cut short by speechSynthesis.cancel(), so onerror's
        // _cancelledByCaller check alone isn't reliable — check here too, or a
        // cancelled utterance can still chain into speaking the next chunk.
        if (_cancelledByCaller) { _isSpeaking = false; return; }
        baseWords += chunkWords;
        emitProgress(baseWords);
        idx++; speakNext();
      };
      utt.onerror = e => {
        clearEst();
        _isSpeaking = false;
        // A deliberate interruption (stopSpeaking) means the caller is already
        // taking over — don't also fire the original onEnd/onError and race it.
        if (_cancelledByCaller) return;
        emitProgress(Infinity);
        if (onError) onError(e);
        else if (onEnd) onEnd();
      };
      window.speechSynthesis.speak(utt);
    }

    speakNext();
  }

  // Halts all speech without touching the progress hook — used internally by
  // speak() when a new line supersedes the old one (the new bubble must start
  // hidden, not snapped to fully-revealed).
  function cancelSpeech() {
    // Sarvam path: invalidate the generation, abort any fetch, stop playback.
    _speakGen++;
    if (_ttsAbort) { try { _ttsAbort.abort(); } catch (_) {} _ttsAbort = null; }
    if (_ttsSource) { try { _ttsSource.stop(); } catch (_) {} _ttsSource = null; }
    // Browser path.
    _cancelledByCaller = true;
    window.speechSynthesis.cancel();
    _isSpeaking = false;
  }

  function stopSpeaking() {
    cancelSpeech();
    // Interrupted mid-line (barge-in, quit): snap the bubble to fully revealed
    // so no half-shown message lingers on screen.
    emitProgress(Infinity);
  }

  // ── Live preview recognition (Sarvam engine only) ──────────────────────────
  // Sarvam transcribes the answer only once it's complete, so on its own the
  // candidate gets no feedback while talking. Where the browser has Web Speech
  // recognition, run it in parallel purely as a LIVE DISPLAY of what's being
  // heard — its interim text feeds onUpdate for the status line, while the
  // authoritative transcript still comes from Sarvam in finishListening().
  function startLivePreview(onText) {
    if (!recognition) return null;
    let finalText = '';
    recognition.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += (finalText ? ' ' : '') + t;
        else interim += t;
      }
      const combined = (finalText + ' ' + interim).trim();
      if (combined && onText) onText({ combined, interim: interim.trim() });
    };
    recognition.onerror = () => {}; // preview is best-effort — a failure just freezes the display
    recognition.onend = () => {
      // Chrome auto-stops continuous recognition after silence; keep the
      // preview alive for as long as we're still capturing the answer.
      if (_isListening && sttEngine === 'sarvam') {
        try { recognition.start(); } catch (_) {}
      }
    };
    try { recognition.start(); } catch (_) { return null; }
    return {
      stop() {
        recognition.onend = null; // don't auto-restart after a deliberate stop
        try { recognition.stop(); } catch (_) {}
      }
    };
  }

  // ── Speech Recognition (answer capture) ────────────────────────────────────
  // onUpdate(update) fires on voice activity while listening:
  //  - browser engine: update.text is the full accumulated transcript so far
  //    (finals + interims), on every recognition result.
  //  - Sarvam engine: update.text carries the live-preview transcript where
  //    Web Speech is available (display only — Sarvam's final transcript is
  //    authoritative), or null when it isn't; every spoken frame triggers the
  //    callback either way so the caller can keep re-arming its pause timer.
  // The caller decides when the candidate is really done, then calls
  // finishListening() to keep the answer (returns the final transcript) or
  // stopListening() to discard it.
  function listen(onUpdate, onError) {
    if (_isListening) return;

    if (sttEngine === 'sarvam') {
      _isListening = true;
      const c = cap = {
        chunks: [], sampleRate: 48000, hadSpeech: false, capture: null,
        preview: null, previewCombined: '', previewInterim: '',
        // Streaming state: Sarvam's per-utterance transcripts accumulate in
        // `segments` as the candidate speaks. On any stream failure the batch
        // REST path in finishListening() takes over using `chunks`.
        ws: null, wsFailed: false, segments: [],
        lastSpeechTs: 0, lastDataTs: 0, flushResolve: null
      };

      // Live display: Sarvam's finalized utterance segments are authoritative;
      // the browser preview recognizer (word-level, best-effort) fills in the
      // words of the utterance currently in progress.
      const updateDisplay = () => {
        if (!onUpdate || cap !== c) return;
        const segs = c.segments.join(' ').trim();
        const display = segs ? (segs + ' ' + c.previewInterim).trim() : c.previewCombined;
        if (display) onUpdate({ text: display, preview: true });
      };

      c.preview = startLivePreview(t => {
        if (cap !== c) return;
        c.previewCombined = t.combined;
        c.previewInterim = t.interim;
        updateDisplay();
      });

      // Real-time transcription over the server's Sarvam relay.
      try {
        const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        c.ws = new WebSocket(`${proto}${location.host}/api/stt-stream?lang=${encodeURIComponent(recognitionLang)}`);
        c.ws.onmessage = ev => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'data' && msg.data && msg.data.transcript) {
              const t = String(msg.data.transcript).trim();
              if (t) { c.segments.push(t); c.lastDataTs = Date.now(); }
              if (c.flushResolve) {
                const r = c.flushResolve;
                c.flushResolve = null;
                r();
              } else {
                // This utterance is now finalized by Sarvam — the preview's
                // running text for it is superseded.
                c.previewInterim = '';
                c.previewCombined = c.segments.join(' ');
                updateDisplay();
              }
            } else if (msg.type === 'error') {
              console.warn('Sarvam stream error:', JSON.stringify(msg.data).slice(0, 200));
              c.wsFailed = true;
            }
          } catch (_) {}
        };
        c.ws.onerror = () => { c.wsFailed = true; };
        c.ws.onclose = () => {
          // Closing while we're still capturing means the stream died early
          // and may have missed audio — the batch fallback covers the answer.
          if (_isListening && cap === c) c.wsFailed = true;
        };
      } catch (_) {
        c.wsFailed = true;
      }

      ensureMic()
        .then(stream => {
          if (!_isListening || cap !== c) return; // cancelled while awaiting the mic
          c.capture = startCapture(stream, frame => {
            if (cap !== c) return;
            c.chunks.push(frame);
            if (frameRms(frame) >= SPEECH_RMS_THRESHOLD) {
              c.hadSpeech = true;
              c.lastSpeechTs = Date.now();
              if (onUpdate) onUpdate({ text: null });
            }
            if (c.ws && !c.wsFailed && c.ws.readyState === 1) {
              try {
                c.ws.send(JSON.stringify({
                  audio: {
                    data: pcm16ToBase64(downsamplePcm16([frame], c.sampleRate)),
                    sample_rate: String(STT_SAMPLE_RATE),
                    encoding: 'audio/wav' // literal enum required by the API; real codec is pcm_s16le via the URL
                  }
                }));
              } catch (_) { c.wsFailed = true; }
            }
          });
          c.sampleRate = c.capture.sampleRate;
        })
        .catch(e => {
          _isListening = false;
          if (cap === c) cap = null;
          if (c.preview) c.preview.stop();
          closeStreamWs(c);
          if (onError) onError(e && e.message ? e.message : 'mic_error');
        });
      return;
    }

    // Browser engine
    if (!recognition) {
      if (onError) onError('not_supported');
      return;
    }

    _browserTranscript = '';
    let finalText = '';

    // We deliberately do NOT stop recognition on the browser's first "final"
    // segment — Chrome finalizes a phrase after a fairly short internal pause
    // (~1s), much shorter than the pause we actually want to tolerate.
    recognition.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += (finalText ? ' ' : '') + t;
        else interim += t;
      }
      const combined = (finalText + ' ' + interim).trim();
      _browserTranscript = combined;
      if (combined && onUpdate) onUpdate({ text: combined });
    };

    recognition.onerror = event => {
      _isListening = false;
      if (onError) onError(event.error);
    };

    recognition.onend = () => {
      _isListening = false;
    };

    _isListening = true;
    try {
      recognition.start();
    } catch (e) {
      _isListening = false;
      if (onError) onError(e.message);
    }
  }

  // Stops capture and returns the candidate's final transcript — synchronous
  // (already-accumulated text) for the browser engine, a short /api/stt round
  // trip for Sarvam. Returns '' when nothing usable was said.
  async function finishListening() {
    if (!_isListening) return '';

    if (sttEngine !== 'sarvam') {
      stopBrowserRecognition();
      return _browserTranscript.trim();
    }

    _isListening = false;
    const c = cap;
    cap = null;
    if (!c) return '';
    if (c.preview) c.preview.stop();
    if (c.capture) c.capture.stop();
    // No voice activity at all — skip the API calls (an all-silence clip
    // wastes quota and can make the model hallucinate a transcript).
    if (!c.hadSpeech || !c.chunks.length) {
      closeStreamWs(c);
      return '';
    }

    // Streaming path first: Sarvam's VAD usually finalized the last utterance
    // during the caller's silence window, so the transcript is already here.
    if (c.ws && !c.wsFailed && c.ws.readyState === 1) {
      const settled = c.segments.length > 0
        && c.lastDataTs > c.lastSpeechTs
        && (Date.now() - c.lastSpeechTs) > 2000;
      if (!settled) {
        // Ask for whatever is still buffered and give it a moment to arrive.
        try { c.ws.send(JSON.stringify({ type: 'flush' })); } catch (_) {}
        await new Promise(res => {
          c.flushResolve = res;
          setTimeout(res, 1500);
        });
        c.flushResolve = null;
      }
      closeStreamWs(c);
      const text = c.segments.join(' ').trim();
      if (text) {
        sttFailures = 0;
        return text;
      }
      // Stream produced nothing despite local voice activity — suspicious;
      // fall through and let batch STT have the full recording.
    } else {
      closeStreamWs(c);
    }

    try {
      const text = await sarvamTranscribe(encodeWav(c.chunks, c.sampleRate));
      sttFailures = 0;
      return text;
    } catch (e) {
      console.warn('Sarvam STT failed:', e.message || e);
      if (++sttFailures >= MAX_ENGINE_FAILURES && recognition) {
        console.warn('Falling back to browser speech recognition for the rest of the interview.');
        sttEngine = 'browser';
      }
      return ''; // caller treats this as silence and moves on gracefully
    }
  }

  function closeStreamWs(c) {
    if (c && c.ws) {
      try { c.ws.close(); } catch (_) {}
      c.ws = null;
    }
  }

  // Cancel/discard: stops capture without transcribing anything.
  function stopListening() {
    if (sttEngine === 'sarvam') {
      _isListening = false;
      if (cap) {
        if (cap.preview) cap.preview.stop();
        if (cap.capture) cap.capture.stop();
        closeStreamWs(cap);
        cap = null;
      }
      return;
    }
    stopBrowserRecognition();
  }

  function stopBrowserRecognition() {
    if (recognition && _isListening) {
      try { recognition.stop(); } catch (_) {}
      _isListening = false;
    }
  }

  // ── Continuous Dictation (whiteboard "speak your solution" mode) ───────────
  // Browser engine: live interim + final chunks exactly as before.
  // Sarvam engine: audio is captured continuously and transcribed in segments
  // (cut at natural pauses), each segment's text arriving via onFinalChunk —
  // slightly delayed rather than word-by-word, but the same callback contract.
  function startDictation(onInterim, onFinalChunk, onError) {
    if (sttEngine === 'sarvam') {
      _isDictating = true;
      dict = {
        chunks: [], sampleCount: 0, silenceRun: 0, hadSpeech: false,
        sampleRate: 48000, capture: null, seq: Promise.resolve(), onFinalChunk
      };
      ensureMic()
        .then(stream => {
          if (!_isDictating || !dict) return;
          dict.capture = startCapture(stream, frame => {
            const d = dict;
            if (!d) return;
            d.chunks.push(frame);
            d.sampleCount += frame.length;
            if (frameRms(frame) >= SPEECH_RMS_THRESHOLD) {
              d.hadSpeech = true;
              d.silenceRun = 0;
            } else {
              d.silenceRun += frame.length;
            }
            const durSec = d.sampleCount / d.sampleRate;
            const silenceSec = d.silenceRun / d.sampleRate;
            if (d.hadSpeech && (durSec >= DICT_MAX_SEGMENT_SEC
              || (durSec >= DICT_MIN_SEGMENT_SEC && silenceSec >= DICT_CUT_SILENCE_SEC))) {
              flushDictationSegment(d);
            }
          });
          dict.sampleRate = dict.capture.sampleRate;
        })
        .catch(e => {
          _isDictating = false;
          dict = null;
          if (onError) onError(e && e.message ? e.message : 'mic_error');
        });
      return;
    }

    // Browser engine
    if (!SpeechRecognition) {
      if (onError) onError('not_supported');
      return;
    }

    dictationRecognition = new SpeechRecognition();
    dictationRecognition.continuous = true;
    dictationRecognition.interimResults = true;
    dictationRecognition.lang = recognitionLang;
    dictationRecognition.maxAlternatives = 1;

    dictationRecognition.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) { if (onFinalChunk) onFinalChunk(t.trim()); }
        else interim += t;
      }
      if (interim && onInterim) onInterim(interim);
    };

    dictationRecognition.onerror = event => {
      // 'no-speech' fires often during natural pauses — not a real error.
      if (event.error === 'no-speech') return;
      _isDictating = false;
      if (onError) onError(event.error);
    };

    dictationRecognition.onend = () => {
      // Chrome auto-stops continuous recognition after a period of silence;
      // restart if the user hasn't stopped it.
      if (_isDictating) {
        try { dictationRecognition.start(); } catch (_) {}
      }
    };

    _isDictating = true;
    try {
      dictationRecognition.start();
    } catch (e) {
      _isDictating = false;
      if (onError) onError(e.message);
    }
  }

  // Sends the segment captured so far off for transcription (serialized so
  // segment texts arrive in speaking order) and resets the capture buffer.
  function flushDictationSegment(d) {
    const chunks = d.chunks;
    const hadSpeech = d.hadSpeech;
    d.chunks = [];
    d.sampleCount = 0;
    d.silenceRun = 0;
    d.hadSpeech = false;
    if (!hadSpeech || !chunks.length) return;

    const blob = encodeWav(chunks, d.sampleRate);
    d.seq = d.seq.then(async () => {
      try {
        const text = await sarvamTranscribe(blob);
        if (text && d.onFinalChunk) d.onFinalChunk(text);
      } catch (e) {
        console.warn('Dictation transcription failed:', e.message || e);
      }
    });
    _dictFlush = d.seq;
  }

  // Returns a promise that resolves once the final dictated segment has been
  // transcribed (immediately for the browser engine), so callers can safely
  // read the accumulated dictation text after awaiting it.
  function stopDictation() {
    _isDictating = false;

    if (dict) {
      const d = dict;
      dict = null;
      if (d.capture) d.capture.stop();
      flushDictationSegment(d);
      return d.seq;
    }

    if (dictationRecognition) {
      try { dictationRecognition.stop(); } catch (_) {}
    }
    return Promise.resolve();
  }

  // Any dictation transcription still in flight (e.g. dictation was stopped
  // manually a moment before the solution was submitted).
  function waitForDictation() {
    return _dictFlush;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    init,
    loadVoice,
    speak,
    prefetch,
    setProgressHook,
    stopSpeaking,
    listen,
    finishListening,
    stopListening,
    startDictation,
    stopDictation,
    waitForDictation,
    releaseMic,
    get isListening() { return _isListening; },
    get isSpeaking() { return _isSpeaking; },
    get isDictating() { return _isDictating; },
    get isIndianVoice() { return _isIndianVoice; },
    get selectedVoiceName() { return selectedVoice ? selectedVoice.name : null; },
    get usesSarvamSTT() { return sttEngine === 'sarvam'; },
    get usesSarvamTTS() { return ttsEngine === 'sarvam'; },
  };
})();
