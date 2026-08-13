/**
 * Recorder — records the whole interview (candidate's camera video + mic
 * audio) via MediaRecorder and streams it to the server in ~10-second chunks
 * while the interview is running, so nothing large ever sits in memory and a
 * mid-interview crash still leaves everything recorded up to that point.
 * Container is webm everywhere except iOS Safari, which has no webm
 * MediaRecorder support and records mp4 instead (see start()/recordingExt).
 *
 * The AI interviewer's voice is browser TTS (speaker output), which the
 * browser cannot capture — the recording is of the candidate, like a
 * proctoring recording. What the AI said is in the transcript.
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
  failed:        false,
  // Chunks must be appended server-side in capture order, so uploads are
  // chained on a single promise queue rather than fired in parallel.
  uploadQueue:   Promise.resolve(),

  CHUNK_MS: 10000,

  /**
   * Starts recording using the already-granted camera stream's video track
   * plus a freshly-requested mic track. Returns true if recording started.
   */
  async start(cameraStream) {
    if (this.mediaRecorder || !window.MediaRecorder || !cameraStream) return false;

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn('Recording disabled — microphone stream unavailable:', e);
      return false;
    }

    try {
      const combined = new MediaStream([
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
        videoBitsPerSecond: 600000, // 320×240 review-quality video ≈ 5 MB/min total
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
      this._releaseAudio();
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

    this._releaseAudio();
    const id = this.failed ? null : this.recordingId;
    this.mediaRecorder = null;
    this.recordingId = null;
    return id;
  },

  _releaseAudio() {
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(t => t.stop());
      this.audioStream = null;
    }
  }
};
