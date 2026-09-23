/**
 * Recorder — records the whole interview via MediaRecorder and streams it to
 * the server in short chunks
 * while the interview is running, so nothing large ever sits in memory and a
 * mid-interview crash still leaves everything recorded up to that point.
 * The HR dashboard's live view reads this same growing file as it's written
 * (see /api/stream/data in server.js), so CHUNK_MS is also the floor on how
 * far behind real time HR sees the candidate.
 * Container is webm everywhere except iOS Safari, which has no webm
 * MediaRecorder support and records mp4 instead (see start()/recordingExt).
 *
 * What is recorded: when the candidate shared their screen (requestScreen(),
 * asked once on the system-check screen) it is the SCREEN — questions and the
 * whiteboard — with the candidate's camera in a corner (already in the frame
 * when the shared surface is this tab, drawn in by us otherwise). Audio is the
 * mic plus the shared tab's audio when the browser offers it (the Sarvam AI
 * voice; browser-fallback TTS can't be captured). Frames are composed on a
 * canvas so the recording stays one fixed-size stream even if the share ends
 * midway — it then falls back to the full camera picture. No share (declined,
 * mobile, unsupported) = camera + mic only. What the AI said is also always in
 * the transcript.
 *
 * Recording is strictly best-effort: any failure (no MediaRecorder support,
 * mic denied, upload errors) disables it silently and must never block or
 * interrupt the interview itself.
 */
const Recorder = {
  mediaRecorder: null,
  recordingId:   null,
  recordingExt:  'webm', // actual container in use — see start(); iOS Safari records mp4
  audioStream:   null,
  screenStream:  null, // getDisplayMedia stream from requestScreen(), if the candidate shared
  _drawTimer:    null,
  _mixCtx:       null,
  failed:        false,
  // Chunks must be appended server-side in capture order, so uploads are
  // chained on a single promise queue rather than fired in parallel.
  uploadQueue:   Promise.resolve(),

  CHUNK_MS: 3000,

  /**
   * Asks the candidate to share their screen (needs a fresh click). Returns
   * 'ok', 'denied' or 'unsupported' — never throws.
   */
  async requestScreen() {
    if (this.screenStream) return 'ok';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return 'unsupported';
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 15 } },
        audio: true,
        preferCurrentTab: true, // Chrome: offers this tab first
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude'
      });
      return 'ok';
    } catch (e) {
      console.warn('Screen share not granted:', e);
      return 'denied';
    }
  },

  // Draws the screen (+ camera corner when needed) onto a 1280×720 canvas and
  // returns [canvas video track, audio track]; audio is mic + shared-tab audio.
  _composeScreen(cameraStream) {
    const W = 1280, H = 720;
    const screenTrack = this.screenStream.getVideoTracks()[0];
    const tab = screenTrack.getSettings().displaySurface === 'browser'; // this tab already shows the camera box
    const mkVideo = tracks => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream(tracks);
      v.play().catch(() => {});
      return v;
    };
    const screenV = mkVideo([screenTrack]);
    const camV = mkVideo(cameraStream.getVideoTracks());
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const fit = (v, x, y, w, h) => { // letterboxed: the shared surface can change shape (e.g. fullscreen)
      const k = Math.min(w / v.videoWidth, h / v.videoHeight);
      ctx.drawImage(v, x + (w - v.videoWidth * k) / 2, y + (h - v.videoHeight * k) / 2, v.videoWidth * k, v.videoHeight * k);
    };
    // ponytail: setInterval is throttled to ~1 fps if the interview tab is backgrounded; fine, tab-switching is warned against
    this._drawTimer = setInterval(() => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const camOk = camV.videoWidth > 0;
      if (screenTrack.readyState === 'live' && screenV.videoWidth > 0) {
        fit(screenV, 0, 0, W, H);
        if (!tab && camOk) fit(camV, W - 240, H - 180, 224, 168);
      } else if (camOk) {
        fit(camV, 0, 0, W, H);
      }
    }, 1000 / 15);
    const video = canvas.captureStream(15).getVideoTracks();

    let audio = this.audioStream.getAudioTracks();
    const shared = this.screenStream.getAudioTracks();
    if (shared.length) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this._mixCtx = new Ctx();
        const dest = this._mixCtx.createMediaStreamDestination();
        this._mixCtx.createMediaStreamSource(this.audioStream).connect(dest);
        this._mixCtx.createMediaStreamSource(new MediaStream(shared)).connect(dest);
        this._mixCtx.resume().catch(() => {});
        audio = dest.stream.getAudioTracks();
      } catch (e) {
        console.warn('Audio mix unavailable — recording mic only:', e);
      }
    }
    return [...video, ...audio];
  },

  /**
   * Starts recording using the already-granted camera stream's video track
   * plus a freshly-requested mic track. Returns true if recording started.
   * @param {MediaStream} cameraStream
   */
  async start(cameraStream) {
    if (this.mediaRecorder || !window.MediaRecorder || !cameraStream) return false;

    try {
      if (cameraStream.getAudioTracks().length > 0) {
        this.audioStream = new MediaStream(cameraStream.getAudioTracks());
      } else {
        this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch (e) {
      console.warn('Recording disabled — microphone stream unavailable:', e);
      this._release();
      return false;
    }

    try {
      let tracks = null;
      if (this.screenStream && this.screenStream.getVideoTracks().some(t => t.readyState === 'live')) {
        try {
          tracks = this._composeScreen(cameraStream);
        } catch (e) {
          console.warn('Screen recording unavailable — recording camera only:', e);
          this._stopCompose();
        }
      }
      const combined = new MediaStream(tracks || [
        ...cameraStream.getVideoTracks(),
        ...this.audioStream.getAudioTracks()
      ]);

      // iOS Safari has no webm MediaRecorder support at all (isTypeSupported
      // returns false for every webm variant), so it needs mp4 candidates too
      // — without them mimeType ends up '', which just makes the browser pick
      // its own default container silently. Order matters: first supported
      // wins, so webm (smaller, universally supported elsewhere) is tried first.
      const mimeType = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4'
      ].find(t => MediaRecorder.isTypeSupported(t)) || '';

      this.recordingId = crypto.randomUUID();
      this.failed = false;
      this.uploadQueue = Promise.resolve();

      this.mediaRecorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: tracks ? 1000000 : 600000, // 1280×720 screen ≈ 8 MB/min; 320×240 camera ≈ 5 MB/min
        audioBitsPerSecond: 64000
      });
      // Read back the ACTUAL mimeType the browser committed to (authoritative
      // even when `mimeType` above was '' and the browser silently chose its
      // own default) so the server saves/serves the right file extension.
      const actualMime = this.mediaRecorder.mimeType || mimeType;
      this.recordingExt = actualMime.includes('mp4') ? 'mp4' : 'webm';
      this.mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) this._enqueueChunk(e.data);
      };
      this.mediaRecorder.start(this.CHUNK_MS);
      return true;
    } catch (e) {
      console.warn('Recording disabled — could not start MediaRecorder:', e);
      this._release();
      this.mediaRecorder = null;
      return false;
    }
  },

  _enqueueChunk(blob) {
    if (this.failed) return;
    this.uploadQueue = this.uploadQueue
      .then(() => fetch(`/api/recording/chunk?id=${this.recordingId}&ext=${this.recordingExt}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob
      }))
      .then(res => { if (!res.ok) throw new Error('chunk upload failed: ' + res.status); })
      .catch(e => {
        // One lost chunk corrupts everything after it in the webm stream, so
        // give up on the recording entirely rather than uploading a broken file.
        console.warn('Recording upload failed — recording abandoned:', e);
        this.failed = true;
      });
  },

  /**
   * Stops recording, waits for the final chunk to flush to the server, and
   * returns the recordingId to attach to the report (null if recording was
   * never running or failed along the way).
   */
  async stop() {
    if (!this.mediaRecorder) return null;

    try {
      if (this.mediaRecorder.state !== 'inactive') {
        // The final dataavailable event fires before onstop resolves.
        await new Promise(resolve => {
          this.mediaRecorder.onstop = resolve;
          this.mediaRecorder.stop();
        });
      }
      await this.uploadQueue;
    } catch (e) {
      console.warn('Error stopping recorder:', e);
      this.failed = true;
    }

    this._release();
    const id = this.failed ? null : this.recordingId;
    this.mediaRecorder = null;
    this.recordingId = null;
    return id;
  },

  _stopCompose() {
    if (this._drawTimer) clearInterval(this._drawTimer);
    this._drawTimer = null;
    if (this._mixCtx) this._mixCtx.close().catch(() => {});
    this._mixCtx = null;
  },

  _release() {
    this._stopCompose();
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(t => t.stop());
      this.audioStream = null;
    }
  }
};
