/**
 * VoiceManager — wraps Web Speech API (SpeechRecognition + SpeechSynthesis).
 * All state is private; public surface is minimal.
 *
 * Speech synthesis runs entirely in the browser (no server/cloud TTS cost),
 * so the AI's accent is only as Indian as whatever voice happens to be
 * installed on the candidate's machine — see pickBestVoice() below for the
 * best-effort selection logic and its limits.
 */
const VoiceManager = (() => {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition = null;
  let selectedVoice = null;
  let _isIndianVoice = false;
  let _isListening = false;
  let _isSpeaking = false;
  let _cancelledByCaller = false;

  let dictationRecognition = null;
  let _isDictating = false;

  // The candidate may speak in any of these; the AI always tries to answer
  // back in Indian English regardless (see pickBestVoice / speak below).
  let recognitionLang = 'en-IN';

  // ── Voice loading ──────────────────────────────────────────────────────────
  // Best-effort: prefer any voice that's actually Indian English. Browsers
  // only expose voices installed on the OS (or, for Chrome, Google's network
  // voices — which don't currently include an Indian English option), so on
  // most machines none of this will match and we fall back to a generic
  // English voice. There is no free, in-browser way to force a genuine
  // Indian accent onto a non-Indian voice.
  function pickBestVoice(voices) {
    // Known-good Indian English voices across the major platforms. Order
    // matters — natural/neural voices first, since they handle Indian names
    // far better than older robotic ones even within the same "Indian" tag.
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
    // Any voice explicitly tagged as Indian English by locale...
    const enIN = voices.find(v => v.lang === 'en-IN' || v.lang === 'en_IN');
    if (enIN) return enIN;
    // ...or just mentioning India/Indian in its name, whatever the vendor calls it.
    const namedIndia = voices.find(v => /india/i.test(v.name));
    if (namedIndia) return namedIndia;
    // Fall back to any English voice rather than a non-English default.
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
  // (e.g. 'en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'mr-IN'). The Web Speech API can
  // only recognise one language per session — it can't auto-detect or switch
  // between these mid-conversation — so this is fixed for the interview based
  // on what the candidate picked at setup. The AI's own spoken replies are
  // always intended to be Indian English, independent of this setting.
  function init(lang) {
    if (!SpeechRecognition) return { supported: false };

    recognitionLang = lang || 'en-IN';

    recognition = new SpeechRecognition();
    // continuous:true so Chrome doesn't silently auto-stop after its own short
    // internal "no speech" timeout (often ~5s, shorter than our 10s grace period
    // and outside our control) — we decide when to give up, not the browser.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = recognitionLang;
    recognition.maxAlternatives = 1;
    return { supported: true };
  }

  // ── Speech Synthesis ───────────────────────────────────────────────────────
  function splitIntoChunks(text, maxLen = 200) {
    if (text.length <= maxLen) return [text];
    // Split on sentence boundaries
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

  function speak(text, onEnd, onError) {
    if (!text || text.trim().length === 0) {
      if (onEnd) onEnd();
      return;
    }

    // A fresh speak() supersedes anything still in flight — its onEnd (if any)
    // must not fire once we've moved on, so mark it cancelled before stopping it.
    _cancelledByCaller = true;
    window.speechSynthesis.cancel();
    _cancelledByCaller = false;
    _isSpeaking = true;

    const chunks = splitIntoChunks(text.trim());
    let idx = 0;

    function speakNext() {
      if (idx >= chunks.length) {
        _isSpeaking = false;
        if (onEnd) onEnd();
        return;
      }
      const utt = new SpeechSynthesisUtterance(chunks[idx]);
      utt.rate = 0.92;
      utt.pitch = 1.05;
      utt.volume = 1.0;
      // Hints Indian English to the engine even when falling back to a
      // non-Indian voice — some engines use this for pronunciation, though
      // most just ignore it and keep the voice's own native accent.
      utt.lang = 'en-IN';
      if (selectedVoice) utt.voice = selectedVoice;

      utt.onend = () => {
        // Some browsers (notably Chrome) fire 'end' rather than 'error' when an
        // utterance is cut short by speechSynthesis.cancel(), so onerror's
        // _cancelledByCaller check alone isn't reliable — check here too, or a
        // cancelled utterance can still chain into speaking the next chunk.
        if (_cancelledByCaller) { _isSpeaking = false; return; }
        idx++; speakNext();
      };
      utt.onerror = e => {
        _isSpeaking = false;
        // A deliberate interruption (stopSpeaking) means the caller is already
        // taking over — don't also fire the original onEnd/onError and race it.
        if (_cancelledByCaller) return;
        if (onError) onError(e);
        else if (onEnd) onEnd();
      };
      window.speechSynthesis.speak(utt);
    }

    speakNext();
  }

  function stopSpeaking() {
    _cancelledByCaller = true;
    window.speechSynthesis.cancel();
    _isSpeaking = false;
  }

  // ── Speech Recognition ─────────────────────────────────────────────────────
  // onUpdate(text) fires on every interim AND final chunk with the full
  // accumulated transcript so far. We deliberately do NOT stop recognition on
  // the browser's first "final" segment — Chrome finalizes a phrase after a
  // fairly short internal pause (~1s), which is much shorter than the pause
  // we actually want to tolerate mid-answer. The caller (App) decides when
  // the candidate is really done, based on its own pause timer, and calls
  // stopListening() at that point.
  function listen(onUpdate, onError) {
    if (!recognition) {
      if (onError) onError('not_supported');
      return;
    }

    let finalText = '';

    recognition.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += (finalText ? ' ' : '') + t;
        else interim += t;
      }
      const combined = (finalText + ' ' + interim).trim();
      if (combined && onUpdate) onUpdate(combined);
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

  function stopListening() {
    if (recognition && _isListening) {
      try { recognition.stop(); } catch (_) {}
      _isListening = false;
    }
  }

  // ── Continuous Dictation (for the whiteboard "speak your solution" mode) ────
  function startDictation(onInterim, onFinalChunk, onError) {
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
      // 'no-speech' fires often during natural pauses — not a real error, just keep going.
      if (event.error === 'no-speech') return;
      _isDictating = false;
      if (onError) onError(event.error);
    };

    dictationRecognition.onend = () => {
      // Chrome auto-stops continuous recognition after a period of silence; restart if user hasn't stopped it.
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

  function stopDictation() {
    _isDictating = false;
    if (dictationRecognition) {
      try { dictationRecognition.stop(); } catch (_) {}
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    init,
    loadVoice,
    speak,
    stopSpeaking,
    listen,
    stopListening,
    startDictation,
    stopDictation,
    get isListening() { return _isListening; },
    get isSpeaking() { return _isSpeaking; },
    get isDictating() { return _isDictating; },
    get isIndianVoice() { return _isIndianVoice; },
    get selectedVoiceName() { return selectedVoice ? selectedVoice.name : null; },
  };
})();
