# HR Live Interview Streaming Guide

## Overview

HR staff can now monitor AI interviews in real-time and see recorded interview videos. This guide explains how to use the live streaming feature.

## How It Works

1. **No Setup Required for Candidates** — Candidates don't need to install OBS or any other tools
2. **Automatic Stream Initiation** — When a candidate starts an interview, a live stream is automatically created
3. **Real-Time Broadcast** — Video and audio chunks are streamed to HR in real-time (same chunks used for final recording)
4. **Same Stream = One Recording** — The candidate only needs camera/mic access once; the same stream is used for live viewing AND recording

## Using the HR Dashboard

### Getting the Stream Link

When a candidate starts an interview, the app automatically initiates a live stream. The stream ID and watch URL are logged to the browser console:

```
[Stream] Live monitoring initiated: a1b2c3d4-e5f6-7g8h-9i0j-1k2l3m4n5o6p
[Stream] HR watch URL: http://localhost:3000/hr-watch/a1b2c3d4-e5f6-7g8h-9i0j-1k2l3m4n5o6p
```

**In production:** The URL will use your domain, e.g., `https://yourdomain.com/hr-watch/{streamId}`

### Accessing the Live Dashboard

1. Open the HR watch URL in a new browser tab while the candidate is taking their interview
2. The dashboard will automatically connect to the live stream
3. You'll see:
   - **Live video feed** from the candidate's camera
   - **Candidate name** and **subject** being interviewed
   - **Stream time** — how long the interview has been running
   - **Stream status** — connection status (Connected/Disconnected/Connecting)

### Connection Management

- **Auto-reconnect** — If the connection drops, the browser automatically attempts to reconnect every 3 seconds
- **Multiple viewers** — Multiple HR staff can watch the same interview simultaneously
- **Interview end** — The stream automatically closes when the interview ends

## Architecture

### Components

1. **Candidate's Interview Tab**
   - Captures camera/mic (full exclusive device access)
   - Runs recording via MediaRecorder
   - Broadcasts chunks to server for HR viewing

2. **Backend (server.js)**
   - `/api/stream/start` — Initiates a new stream session
   - `/api/stream/chunk` — Receives and broadcasts video chunks to connected HR viewers
   - `/api/stream/end` — Closes the stream when interview ends
   - WebSocket server at `/api/stream/watch` — Streams chunks to HR viewers

3. **HR Dashboard (hr-watch.html)**
   - Connects to WebSocket stream
   - Reconstructs video from chunks using MediaSource API
   - Displays in HTML5 video player

4. **Recorder (recorder.js)**
   - Sends chunks to `/api/recording/chunk` (for final recording)
   - Also sends chunks to `/api/stream/chunk` (for live HR viewing)
   - Fire-and-forget approach — stream failures don't block recording

### Device Access

**Problem Solved:** Browsers lock media devices to one tab at a time.

**Solution:**
- Candidate accesses camera/mic from **AI interview tab only**
- Video chunks are **streamed server-side** to HR viewers
- HR viewers don't need device access — they receive the video stream via WebSocket
- Google Meet can be open in another tab without conflicts

## Technical Details

### Streaming Protocol

- **Transport:** WebSocket (binary frames)
- **Message Format:**
  - Metadata: JSON text message with candidate name, subject, start time
  - Chunks: Binary format with 4-byte size prefix + video data
- **Container:** Same webm/mp4 format used for final recording
- **Latency:** ~10 second chunks (matching recorder configuration)

### Stream Lifecycle

```
Candidate starts interview
    ↓
[App] POST /api/stream/start → receives streamId
    ↓
[App] Passes streamId to Recorder
    ↓
[Recorder] Sends chunks to both:
    • /api/recording/chunk (for final file)
    • /api/stream/chunk (for HR broadcast)
    ↓
[Server] Broadcasts chunks to all connected HR viewers via WebSocket
    ↓
HR viewers reconstruct video from chunks
    ↓
Interview ends
    ↓
[App] POST /api/stream/end → closes all HR connections
    ↓
Recording is saved as usual
```

## Workflow Example

### Scenario: HR Monitoring an Interview

1. **Candidate Setup** (before interview)
   - Candidate opens the interview page
   - Clicks "Begin Interview"
   - Camera/mic request appears → Grants permission
   - Interview starts

2. **HR Monitoring** (during interview)
   - HR opens browser console of candidate's page (or checks your monitoring dashboard)
   - Finds the stream URL: `/hr-watch/{streamId}`
   - Opens that URL in a new tab
   - Dashboard shows: live video feed, candidate name, subject, timer
   - HR can watch the entire interview in real-time

3. **After Interview** (when candidate finishes)
   - HR dashboard shows "Disconnected"
   - Recording is automatically saved
   - HR can later review the full recording from the admin panel

## Troubleshooting

### "Stream not found" error
- The stream ID is invalid or expired
- Stream expires 1 minute after all viewers disconnect
- Refresh and get a new stream ID from the console

### Video won't play
- Check browser console for errors (Ctrl+Shift+K)
- Ensure your browser supports MediaSource API
- Try a different browser (Chrome, Firefox, Edge recommended)

### Connection keeps dropping
- Verify WebSocket is not blocked by firewall
- Check `/api/stream/watch` endpoint is accessible
- Look for network errors in browser DevTools (Network tab)

### Multiple viewers causes lag
- Live streaming doesn't support unlimited concurrent viewers
- Recommended: 2-3 HR staff watching simultaneously
- For group viewing, use screen sharing from one viewer's tab instead

## API Reference

### POST /api/stream/start
Initiates a new live stream session.

**Request:**
```json
{
  "recordingId": "temp-{timestamp}",
  "candidateName": "John Doe",
  "subject": "Mathematics"
}
```

**Response:**
```json
{
  "streamId": "a1b2c3d4-e5f6-7g8h-9i0j-1k2l3m4n5o6p"
}
```

### POST /api/stream/chunk
Receives and broadcasts video chunks.

**Request:**
- Method: POST
- Query: `?id={streamId}`
- Body: Binary video data
- Content-Type: application/octet-stream

**Response:**
```json
{
  "success": true,
  "viewerCount": 2
}
```

### POST /api/stream/end
Ends a stream and disconnects all viewers.

**Request:**
```json
{
  "streamId": "a1b2c3d4-e5f6-7g8h-9i0j-1k2l3m4n5o6p"
}
```

**Response:**
```json
{
  "success": true
}
```

### WebSocket /api/stream/watch
Connects to a live stream.

**URL:** `ws://localhost:3000/api/stream/watch?id={streamId}`

**Messages Received:**
- Text: Metadata JSON (once at connection)
- Binary: Video chunks (repeatedly)

## Security Notes

- Stream IDs are cryptographically random UUIDs
- Streams are not password-protected (use your existing network security)
- Consider restricting `/hr-watch/` endpoint to your internal network
- Stream data is not persisted (only the final recording is saved)

## FAQ

**Q: Can I rewatch a stream later?**
A: No, streams are live-only. However, the full interview is recorded and stored for later review via the admin panel.

**Q: Does the candidate know they're being watched?**
A: The candidate sees the interview as usual. You may want to inform candidates that interviews are monitored by HR.

**Q: Can HR control the interview (pause, skip questions)?**
A: No, HR has view-only access. All interview control remains with the candidate and AI.

**Q: What if the HR stream drops mid-interview?**
A: The interview continues unaffected. HR can reconnect by opening the stream URL again. The recording is always saved on the server.

**Q: Is there latency?**
A: Yes, approximately 10 seconds (one chunk interval). This is the same as the recording chunk interval.

**Q: Can I zoom the video?**
A: Yes, use your browser's zoom (Ctrl+Plus) or double-click the video element.

## Performance Considerations

- **Bandwidth per viewer:** ~600 kbps (video) + ~64 kbps (audio) = ~664 kbps per concurrent viewer
- **Server CPU:** Minimal (just forwarding chunks)
- **Recommended concurrent viewers:** 2-5 per interview
- **Scaling:** To support many concurrent viewers, consider a media server (e.g., WebRTC SFU)

## Future Enhancements

Possible additions for future versions:
- [ ] Recording pauses/moments highlighting during live view
- [ ] Candidate webcam snapshots at key moments
- [ ] Feedback widget for HR to leave notes (archived with recording)
- [ ] Multi-interview dashboard (grid view of multiple streams)
- [ ] Stream quality adjustment (adaptive bitrate)
- [ ] RTMP/HLS export for group viewing

---

**Questions?** Check the server logs for stream lifecycle events:
```
[Stream] Live monitoring initiated: {streamId}
```
