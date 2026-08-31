# HR Live Interview Monitoring - Quick Start

## 30-Second Setup

No setup needed! Here's how to watch an interview in real-time:

### Step 1: Get the Stream URL
When a candidate starts their interview, the app logs the watch URL. Check the browser console:

1. Open the candidate's interview page
2. Press `Ctrl+Shift+K` (or `Cmd+Option+K` on Mac) to open Developer Console
3. Look for this message:
   ```
   [Stream] HR watch URL: http://localhost:3000/hr-watch/a1b2c3d4-e5f6-...
   ```

### Step 2: Open the Dashboard
1. Copy the full URL
2. Open it in a new browser tab
3. You'll see the live video feed!

### Step 3: Watch the Interview
- **Video** — Live candidate feed
- **Timer** — How long the interview has been running
- **Status** — Shows "Connected" when streaming
- **Refresh** — Reconnect if connection drops
- **Exit** — Close the dashboard

## That's It!

The dashboard will:
- ✅ Show live video from the candidate's camera
- ✅ Auto-reconnect if the network hiccups
- ✅ Display candidate name and subject
- ✅ Close automatically when the interview ends

## What You're Seeing

You're watching the **exact same video** that gets saved as the final recording. No separate camera feed needed.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Black screen | Interview hasn't started yet, or URL is wrong |
| "Disconnected" status | Stream ended or connection was lost. Check URL and try again. |
| Video lags | Normal — there's a ~10 second delay (one chunk interval) |
| Can't find the URL | Search console for `[Stream]` |
| Page won't load | Check your network/firewall settings |

## Tips

- **Multiple watchers:** Multiple HR staff can open the same URL simultaneously
- **No pausing:** You're watching live only (no pause/rewind during interview)
- **Full recording saved:** Even if you disconnect, the full interview is recorded
- **Dark mode:** Works great in light or dark browser theme
- **Mobile:** Works on tablets and phones too

## Behind the Scenes

You don't need to know this, but here's what's happening:
- Candidate's interview captures camera/mic in their browser
- Video chunks are sent to the server every ~10 seconds
- Your dashboard connects to the server and receives those chunks
- Browser reconstructs the video stream in real-time
- Google Meet can be open in another tab without conflicts (your dashboard is watching, not the Meet tab)

## Common Questions

**Q: Can I control the interview?**  
A: No, you can only watch. The candidate controls their answers and submissions.

**Q: What if they switch tabs?**  
A: The interview might pause if they go to Google Meet (browser limitation), but your stream will still show the last frame. When they switch back, it resumes.

**Q: Is it secure?**  
A: The stream URL is unique and unpredictable. Treat it like any sensitive link — don't share it publicly.

**Q: Can I save the stream?**  
A: The full interview is automatically saved. Access the recording later from the Admin Dashboard.

**Q: What happens if my connection drops?**  
A: The dashboard will try to reconnect automatically. If it can't reconnect within a minute, refresh the page.

**Q: Can I watch multiple interviews at once?**  
A: Yes, open each stream in a separate tab.

## Getting Help

1. Check the **HR_LIVE_STREAMING_GUIDE.md** for detailed docs
2. Look in browser console (Ctrl+Shift+K) for error messages
3. Try a different browser if issues persist
4. Contact your system admin if the stream URL isn't appearing

---

**Enjoy real-time monitoring! 🎉**
