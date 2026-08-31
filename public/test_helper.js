(function() {
  const urlParams = new URLSearchParams(window.location.search);
  if (!urlParams.has('run_test')) {
    return;
  }

  console.log("=========================================");
  console.log("INTEGRATION TEST HELPER ACTIVATED");
  console.log("=========================================");

  // 1. Mock getUserMedia
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      console.log("[Mock GETUSERMEDIA] called with:", constraints);
      return {
        getTracks: () => [],
        getVideoTracks: () => [{ stop: () => {} }],
        getAudioTracks: () => [{ stop: () => {} }]
      };
    };
  }

  // 2. Mock App camera access and monitoring
  window.addEventListener('load', () => {
    if (typeof App !== 'undefined') {
      console.log("[Mock APP] Overriding camera, media permission, and whiteboard methods");
      
      App._requestCameraAccess = async function() {
        console.log("[Mock APP] Request camera access granted");
        this.s.cameraEnabled = true;
        this.s.cameraStream = {
          getVideoTracks: () => [{ stop: () => {} }],
          getAudioTracks: () => [{ stop: () => {} }]
        };
        return true;
      };

      // Mock request fullscreen to avoid browser security blocking it
      App._requestFullscreen = async function() {
        console.log("[Mock APP] Fullscreen mock triggered");
        return true;
      };

      // Disable toast notifications in test console noise, or log them
      const originalShowToast = App.showToast;
      App.showToast = function(msg, type) {
        console.log(`[App Toast - ${type}]: ${msg}`);
        // Still call original to render it on screen
        if (originalShowToast) originalShowToast.call(App, msg, type);
      };
    }

    if (typeof Recorder !== 'undefined') {
      console.log("[Mock RECORDER] Overriding recorder start/stop");
      Recorder.start = async function(cameraStream) {
        console.log("[Mock RECORDER] Recorder started");
        this.mediaRecorder = {
          state: 'recording',
          start: () => {},
          stop: () => { if (this.mediaRecorder.onstop) this.mediaRecorder.onstop(); },
          mimeType: 'video/webm'
        };
        this.recordingId = '12345678-1234-1234-1234-123456789012';
        this.failed = false;
        return true;
      };

      Recorder.stop = async function() {
        console.log("[Mock RECORDER] Recorder stopped");
        this.mediaRecorder = null;
        return '12345678-1234-1234-1234-123456789012';
      };
    }

    if (typeof VoiceManager !== 'undefined') {
      console.log("[Mock VOICEMANAGER] Overriding speech input and output");
      
      VoiceManager.init = async function(lang) {
        console.log("[Mock VOICEMANAGER] Init speech helper for lang:", lang);
        return { supported: true };
      };

      VoiceManager.loadVoice = async function() {
        console.log("[Mock VOICEMANAGER] Mock loadVoice");
        return true;
      };

      VoiceManager.speak = function(text, onEnd) {
        console.log("[Mock VOICEMANAGER] Speaking text:", text);
        // Instantly trigger end of speech to run test fast
        setTimeout(() => {
          console.log("[Mock VOICEMANAGER] Speech finished speaking");
          if (onEnd) onEnd();
        }, 100);
      };

      VoiceManager.listen = function(onUpdate, onError) {
        console.log("[Mock VOICEMANAGER] Listening started...");
      };

      VoiceManager.finishListening = async function() {
        console.log("[Mock VOICEMANAGER] finishListening called");
        return "This is a mock answer from speech input.";
      };
    }

    if (typeof Whiteboard !== 'undefined') {
      console.log("[Mock WHITEBOARD] Mocking content checks");
      Whiteboard.hasContent = () => true;
      Whiteboard.exportPNG = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    }

    // Start automation loop
    startTestAutomation();
  });

  function startTestAutomation() {
    console.log("[Test Automation] Starting automation loops...");
    
    // Step 1: Upload a mock resume file programmatically
    setTimeout(() => {
      console.log("[Test Automation] Preparing mock resume file for upload...");
      const text = `Name: Priya Sharma
Experience: 6 years
Current Institute: Vedantu Master Teacher, Physics Department
Education: B.Tech in Physics, IIT Bombay, 2018
Subjects Taught: Physics, Mathematics
Achievements: Produced AIR 45 and AIR 120 in JEE Advanced 2023. Awarded Best Educator 2024.
Summary: An experienced Physics teacher with a track record of producing top ranks in JEE.`;
      
      const file = new File([text], "mock_resume.txt", { type: "text/plain" });
      console.log("[Test Automation] Uploading mock resume file...");
      App._handleResumeFile(file);
    }, 1500);

    // Step 2: Form configuration and loop to drive the interview
    let setupStarted = false;
    let whiteboardCount = 0;
    
    const interval = setInterval(() => {
      const statusTextEl = document.getElementById('status-text');
      const status = statusTextEl ? statusTextEl.textContent : '';
      
      const screenSetup = document.getElementById('screen-setup');
      const screenInterview = document.getElementById('screen-interview');
      const screenProblem = document.getElementById('screen-problem');
      const screenReport = document.getElementById('screen-report');

      // Setup screen logic
      if (screenSetup && screenSetup.classList.contains('active')) {
        if (App.s.resumeAnalyzed && !App.s.resumeAnalyzing && !setupStarted) {
          setupStarted = true;
          console.log("[Test Automation] Resume analyzed. Configuring form fields...");
          
          // Select subject and language
          document.getElementById('subject-select').value = "Physics";
          document.getElementById('language-select').value = "en-IN";
          
          setTimeout(() => {
            const startBtn = document.getElementById('start-btn');
            if (startBtn && !startBtn.disabled) {
              console.log("[Test Automation] Clicking 'Begin Interview' button...");
              startBtn.click();
            }
          }, 1000);
        }
      }

      // Interview / Voice screen logic
      if (screenInterview && screenInterview.classList.contains('active')) {
        if (status.includes('Listening') && !App.s.isProcessing) {
          let ans = "I am doing well, ready to answer questions.";
          if (App.stage === 'WELLBEING') {
            ans = "I am doing great today, excited for this opportunity!";
          } else if (App.stage === 'RESUME_QA') {
            ans = "Yes, I produced AIR 45 in JEE 2023 by using structured problem-solving assignments.";
          } else if (App.s.awaitingProblemFollowUp) {
            ans = "I used conservation of energy because there are no non-conservative forces doing work.";
          }
          
          console.log(`[Test Automation] Candidate answering: "${ans}"`);
          App.handleAnswer(ans);
        }
      }

      // Whiteboard screen logic
      if (screenProblem && screenProblem.classList.contains('active')) {
        const submitBtn = document.getElementById('submit-solution-btn');
        if (submitBtn && !submitBtn.disabled && !submitBtn.textContent.includes('Evaluating')) {
          whiteboardCount++;
          console.log(`[Test Automation] Whiteboard Round ${whiteboardCount} loaded. Submitting solution...`);
          // Set some dummy dictated text as well
          App.s.dictatedText = "The answer is option B. We calculate this by setting kinetic energy equal to potential energy.";
          submitBtn.click();
        }
      }

      // Final report screen logic
      if (screenReport && screenReport.classList.contains('active')) {
        console.log("[Test Automation] Report screen reached! Test completed successfully.");
        clearInterval(interval);
        
        // Expose a global variable so browser subagent can check it
        window.TEST_COMPLETED = true;
      }
    }, 1500);
  }
})();
