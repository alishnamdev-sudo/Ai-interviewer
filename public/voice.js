/**
 * VoiceManager — wraps Web Speech API (SpeechRecognition + SpeechSynthesis)
 * All state is private; public surface is minimal.
 */
const VoiceManager = (() => {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition = null;
  let selectedVoice = null;
  let _isListening = false;
  let _isSpeaking = false;
  let _cancelledByCaller = false;

  let dictationRecognition = null;
  let _isDictating = false;

  // ── Voice loading ──────────────────────────────────────────────────────────
  function pickBestVoice(voices) {
    const preferred = [
      'Google UK English Female',
      'Microsoft Zira - English (United States)',
      'Google US English',
      'Samantha',
      'Alex',
      'Google UK English Male',
    ];
    for (const name of preferred) {
      const v = voices.find(v => v.name === name);
      if (v) return v;
    }
    return voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0] || null;
  }

  function loadVoice() {
    return new Promise(resolve => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        selectedVoice = pickBestVoice(voices);
        resolve();
      } else {
        window.speechSynthesis.addEventListener('voiceschanged', () => {
          selectedVoice = pickBestVoice(window.speechSynthesis.getVoices());
          resolve();
        }, { once: true });
        // Timeout fallback in case voiceschanged never fires
        setTimeout(resolve, 1500);
      }
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (!SpeechRecognition) return { supported: false };

    recognition = new SpeechRecognition();
    // continuous:true so Chrome doesn't silently auto-stop after its own short
    // internal "no speech" timeout (often ~5s, shorter than our 10s grace period
    // and outside our control) — we decide when to give up, not the browser.
    // We explicitly stop() once we get a real final result (see listen() below).
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
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
      if (selectedVoice) utt.voice = selectedVoice;

      utt.onend = () => { idx++; speakNext(); };
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
  function listen(onFinal, onInterim, onError) {
    if (!recognition) {
      if (onError) onError('not_supported');
      return;
    }

    recognition.onresult = event => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      if (interim && onInterim) onInterim(interim);
      if (final) {
        _isListening = false;
        // continuous:true keeps the mic open past one utterance — we only want
        // this one answer, so stop it ourselves now that we have a result.
        try { recognition.stop(); } catch (_) {}
        onFinal(final.trim());
      }
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
    dictationRecognition.lang = 'en-US';
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
  };
})();
