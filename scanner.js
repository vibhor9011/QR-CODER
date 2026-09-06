/*
 * ================================================================
 * HOSTEL EVENT COMMITTEE — PERMANENT QR SCANNER ENGINE
 * ================================================================
 *
 * UI / audio / camera controls are handled here.
 * The existing Apps Script verification endpoint is intentionally
 * preserved. Do NOT change the backend URL unless your deployment
 * changes.
 * ================================================================
 */

const APPS_SCRIPT_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbxYvVpVVpHhWbnVlVHVUq0iVEgyts3Ma_YDpDMqCECejFLqfeFyCOiEn7tQ_tjV5gud/exec";

/* DOM */
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const cameraArea = document.getElementById("cameraArea");
const cameraMessage = document.getElementById("cameraMessage");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const statusBox = document.getElementById("status");
const operatorInput = document.getElementById("operator");
const resultCard = document.getElementById("resultCard");
const resultIcon = document.getElementById("resultIcon");
const resultStatus = document.getElementById("resultStatus");
const resultMessage = document.getElementById("resultMessage");
const resultDetails = document.getElementById("resultDetails");
const scanAgainButton = document.getElementById("scanAgainButton");
const soundButton = document.getElementById("soundButton");
const fullscreenButton = document.getElementById("fullscreenButton");
const torchButton = document.getElementById("torchButton");
const switchCameraButton = document.getElementById("switchCameraButton");
const liveDot = document.getElementById("liveDot");
const liveText = document.getElementById("liveText");

/* State */
let stream = null;
let scanning = false;
let requestInProgress = false;
let animationFrameId = null;
let lastToken = "";
let lastScanTime = 0;
let audioContext = null;
let soundEnabled = true;
let torchOn = false;
let facingMode = "environment";
let currentTrack = null;

const SAME_QR_COOLDOWN_MS = 2500;

/* ================================================================
   STATUS + LIVE INDICATOR
   ================================================================ */

function setStatus(message, type) {
  statusBox.textContent = message;
  statusBox.className = "status " + (type || "neutral");
}

function setLive(active, text) {
  liveDot.classList.toggle("active", !!active);
  liveText.textContent = text || (active ? "SCANNER ACTIVE" : "SCANNER READY");
}

/* ================================================================
   AUDIO FEEDBACK
   Browser rule: audio can only reliably start after a user gesture.
   START CAMERA / SCAN NEXT both count as user gestures.
   ================================================================ */

function initAudio() {
  if (!soundEnabled) return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    if (!audioContext) {
      audioContext = new AudioCtx();
    }

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(function () {});
    }
  } catch (error) {
    console.warn("Audio initialization failed:", error);
  }
}

function playTone(frequency, duration, volume, type, delay) {
  if (!soundEnabled || !audioContext) return;

  try {
    const now = audioContext.currentTime + (delay || 0);
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = type || "sine";
    oscillator.frequency.setValueAtTime(frequency, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(volume || 0.08, 0.001),
      now + 0.012
    );
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      now + duration
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(now);
    oscillator.stop(now + duration + 0.025);
  } catch (error) {
    console.warn("Tone playback failed:", error);
  }
}

function playSuccessSound() {
  initAudio();
  playTone(880, 0.12, 0.16, "sine", 0);
  playTone(1175, 0.18, 0.15, "sine", 0.13);
  playTone(1480, 0.22, 0.12, "sine", 0.29);
}

function playDuplicateSound() {
  initAudio();
  playTone(520, 0.14, 0.14, "square", 0);
  playTone(520, 0.14, 0.14, "square", 0.18);
  playTone(700, 0.18, 0.10, "sine", 0.36);
}

function playErrorSound() {
  initAudio();
  playTone(220, 0.22, 0.16, "sawtooth", 0);
  playTone(170, 0.28, 0.14, "sawtooth", 0.24);
}

function playDetectSound() {
  initAudio();
  playTone(720, 0.07, 0.08, "sine", 0);
}

function toggleSound() {
  soundEnabled = !soundEnabled;

  soundButton.classList.toggle("active", soundEnabled);
  soundButton.textContent = soundEnabled ? "🔊" : "🔇";
  soundButton.title = soundEnabled ? "Sound enabled" : "Sound muted";

  if (soundEnabled) {
    initAudio();
    playTone(880, 0.1, 0.1, "sine", 0);
  }
}

/* ================================================================
   CAMERA SUPPORT
   ================================================================ */

function cameraSupported() {
  return (
    window.isSecureContext &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/* ================================================================
   START CAMERA
   ================================================================ */

async function startCamera() {
  hideResult();
  initAudio();

  if (!cameraSupported()) {
    setStatus(
      "Camera access requires HTTPS. Open this scanner through GitHub Pages.",
      "error"
    );
    cameraMessage.textContent = "HTTPS camera access is required.";
    setLive(false, "HTTPS REQUIRED");
    return;
  }

  if (APPS_SCRIPT_WEB_APP_URL.indexOf("PASTE_YOUR_APPS_SCRIPT") !== -1) {
    setStatus(
      "Scanner backend URL has not been configured in scanner.js.",
      "error"
    );
    return;
  }

  stopCamera();

  setStatus("Requesting camera permission...", "neutral");
  cameraMessage.textContent = "Requesting camera permission...";
  setLive(false, "REQUESTING CAMERA");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    currentTrack = stream.getVideoTracks()[0] || null;

    video.srcObject = stream;
    await video.play();

    scanning = true;
    requestInProgress = false;
    lastToken = "";
    lastScanTime = 0;
    torchOn = false;
    torchButton.classList.remove("active");

    startButton.disabled = true;
    stopButton.disabled = false;

    cameraMessage.textContent = "Point the camera at a QR code.";
    setStatus("CAMERA ACTIVE — SCANNING", "neutral");
    setLive(true, "SCANNER ACTIVE");

    playTone(660, 0.09, 0.07, "sine", 0);

    scanFrame();
  } catch (error) {
    handleCameraError(error);
  }
}

/* ================================================================
   CAMERA ERROR
   ================================================================ */

function handleCameraError(error) {
  stopCamera();

  let message = "Unable to access the camera.";

  if (error && error.name === "NotAllowedError") {
    message =
      "Camera permission was denied. Allow camera access in browser settings and try again.";
  } else if (error && error.name === "NotFoundError") {
    message = "No camera was found on this device.";
  } else if (error && error.name === "NotReadableError") {
    message = "The camera is already being used by another application.";
  } else if (error && error.name === "SecurityError") {
    message =
      "Camera access was blocked. Make sure the scanner is opened over HTTPS.";
  } else if (error && error.name === "OverconstrainedError") {
    message =
      "The selected camera mode is unavailable. Try switching the camera.";
  }

  cameraMessage.textContent = message;
  setStatus(message, "error");
  setLive(false, "CAMERA ERROR");
  playErrorSound();
}

/* ================================================================
   STOP CAMERA
   ================================================================ */

function stopCamera() {
  scanning = false;
  requestInProgress = false;

  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  if (stream) {
    stream.getTracks().forEach(function (track) {
      track.stop();
    });
    stream = null;
  }

  currentTrack = null;
  video.srcObject = null;
  torchOn = false;
  torchButton.classList.remove("active");

  startButton.disabled = false;
  stopButton.disabled = true;

  setLive(false, "SCANNER READY");
}

/* ================================================================
   QR LOOP
   ================================================================ */

function scanFrame() {
  if (!scanning) return;

  if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
    const width = video.videoWidth;
    const height = video.videoHeight;

    if (width > 0 && height > 0) {
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d", {
        willReadFrequently: true
      });

      context.drawImage(video, 0, 0, width, height);

      const imageData = context.getImageData(
        0,
        0,
        width,
        height
      );

      const qr = window.jsQR
        ? jsQR(
            imageData.data,
            imageData.width,
            imageData.height,
            { inversionAttempts: "attemptBoth" }
          )
        : null;

      if (qr && qr.data) {
        handleQRDetected(qr.data);
      }
    }
  }

  animationFrameId = requestAnimationFrame(scanFrame);
}

/* ================================================================
   QR DETECTED
   ================================================================ */

function handleQRDetected(rawValue) {
  const token = String(rawValue || "").trim();

  if (!token || requestInProgress) return;

  const now = Date.now();

  if (
    token === lastToken &&
    now - lastScanTime < SAME_QR_COOLDOWN_MS
  ) {
    return;
  }

  lastToken = token;
  lastScanTime = now;
  requestInProgress = true;

  playDetectSound();

  setStatus("QR DETECTED — VERIFYING...", "warning");
  cameraMessage.textContent = "QR detected. Verifying entry...";
  setLive(true, "VERIFYING");

  verifyToken(token);
}

/* ================================================================
   BACKEND REQUEST
   ================================================================ */

async function verifyToken(token) {
  const operator = operatorInput.value.trim();

  try {
    const url = new URL(APPS_SCRIPT_WEB_APP_URL);

    url.searchParams.set("action", "scan");
    url.searchParams.set("token", token);

    if (operator) {
      url.searchParams.set("operator", operator);
    }

    const result = await requestJSONP(url.toString());
    handleBackendResult(result);
  } catch (error) {
    requestInProgress = false;

    setStatus(
      "Unable to contact the scanner backend.",
      "error"
    );
    cameraMessage.textContent = "Backend connection failed.";
    setLive(false, "BACKEND ERROR");
    playErrorSound();
  }
}

/* ================================================================
   JSONP
   ================================================================ */

function requestJSONP(url) {
  return new Promise(function (resolve, reject) {
    const callbackName =
      "__hplQRCallback_" +
      Date.now() +
      "_" +
      Math.floor(Math.random() * 100000);

    const script = document.createElement("script");
    let finished = false;

    const timeout = setTimeout(function () {
      if (finished) return;

      finished = true;
      cleanup();

      reject(new Error("Scanner backend timeout."));
    }, 15000);

    window[callbackName] = function (data) {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);
      cleanup();
      resolve(data);
    };

    function cleanup() {
      delete window[callbackName];

      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    }

    script.onerror = function () {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);
      cleanup();

      reject(new Error("Backend request failed."));
    };

    const separator = url.indexOf("?") >= 0 ? "&" : "?";

    script.src =
      url +
      separator +
      "callback=" +
      encodeURIComponent(callbackName);

    document.head.appendChild(script);
  });
}

/* ================================================================
   BACKEND RESULT
   ================================================================ */

function handleBackendResult(result) {
  requestInProgress = false;

  if (!result || typeof result !== "object") {
    showResult(
      "ERROR",
      "INVALID SERVER RESPONSE",
      "The scanner backend returned an invalid response.",
      "error"
    );

    setStatus("INVALID SERVER RESPONSE", "error");
    setLive(false, "SERVER ERROR");
    playErrorSound();
    stopCamera();
    return;
  }

  const status = String(result.status || "").toUpperCase();

  if (result.success === true && status === "VALID") {
    showResult(
      "ENTRY ALLOWED",
      "VALID QR CODE",
      buildDetails(result),
      "success"
    );

    setStatus("ENTRY ALLOWED", "success");
    setLive(false, "ENTRY ALLOWED");
    playSuccessSound();
    stopCamera();
    return;
  }

  if (status === "DUPLICATE") {
    showResult(
      "ALREADY SCANNED",
      "DUPLICATE QR CODE",
      buildDetails(result),
      "warning"
    );

    setStatus("ALREADY SCANNED", "warning");
    setLive(false, "DUPLICATE");
    playDuplicateSound();
    stopCamera();
    return;
  }

  if (status === "INVALID") {
    showResult(
      "INVALID QR",
      "ENTRY NOT ALLOWED",
      result.message || "This QR code is not registered.",
      "error"
    );

    setStatus("INVALID QR CODE", "error");
    setLive(false, "ENTRY DENIED");
    playErrorSound();
    stopCamera();
    return;
  }

  showResult(
    "ERROR",
    "SCANNER ERROR",
    result.message || "An unexpected scanner error occurred.",
    "error"
  );

  setStatus("SCANNER ERROR", "error");
  setLive(false, "SCANNER ERROR");
  playErrorSound();
  stopCamera();
}

/* ================================================================
   RESULT UI
   ================================================================ */

function buildDetails(result) {
  const parts = [];

  if (result.scanCount !== undefined) {
    parts.push("Scan count: " + result.scanCount);
  }

  if (result.scannedAt) {
    const date = new Date(result.scannedAt);

    if (!isNaN(date.getTime())) {
      parts.push("Time: " + date.toLocaleString());
    }
  }

  return parts.length ? parts.join(" • ") : "";
}

function showResult(status, title, details, type) {
  resultCard.classList.remove("hidden", "success", "warning", "error", "pulse");
  void resultCard.offsetWidth;
  resultCard.classList.add(type, "pulse");

  resultStatus.textContent = title;
  resultMessage.textContent = status;
  resultDetails.textContent = details || "";

  resultIcon.textContent =
    type === "success" ? "✓" :
    type === "warning" ? "!" :
    "×";

  resultCard.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });
}

function hideResult() {
  resultCard.classList.add("hidden");
  resultCard.classList.remove("success", "warning", "error", "pulse");
}

/* ================================================================
   SCAN NEXT
   ================================================================ */

function scanNext() {
  initAudio();
  hideResult();

  lastToken = "";
  lastScanTime = 0;
  requestInProgress = false;

  startCamera();
}

/* ================================================================
   TORCH / FLASHLIGHT
   ================================================================ */

async function toggleTorch() {
  if (!currentTrack) {
    setStatus("Start the camera before using the flashlight.", "warning");
    return;
  }

  const capabilities =
    typeof currentTrack.getCapabilities === "function"
      ? currentTrack.getCapabilities()
      : {};

  if (!capabilities.torch) {
    setStatus(
      "Flashlight control is not supported by this device/browser.",
      "warning"
    );
    return;
  }

  try {
    torchOn = !torchOn;

    await currentTrack.applyConstraints({
      advanced: [{ torch: torchOn }]
    });

    torchButton.classList.toggle("active", torchOn);
  } catch (error) {
    torchOn = false;
    torchButton.classList.remove("active");

    setStatus("Unable to control the flashlight.", "warning");
  }
}

/* ================================================================
   CAMERA SWITCH
   ================================================================ */

async function switchCamera() {
  facingMode = facingMode === "environment" ? "user" : "environment";

  if (!stream) {
    setStatus(
      facingMode === "environment"
        ? "Rear camera selected."
        : "Front camera selected.",
      "neutral"
    );
    return;
  }

  const wasScanning = scanning;

  if (wasScanning) {
    stopCamera();
    await startCamera();
  }
}

/* ================================================================
   FULLSCREEN
   ================================================================ */

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      fullscreenButton.textContent = "×";
      fullscreenButton.title = "Exit fullscreen";
    } else {
      await document.exitFullscreen();
      fullscreenButton.textContent = "⛶";
      fullscreenButton.title = "Enter fullscreen";
    }
  } catch (error) {
    setStatus("Fullscreen is not supported by this browser.", "warning");
  }
}

document.addEventListener("fullscreenchange", function () {
  if (!document.fullscreenElement) {
    fullscreenButton.textContent = "⛶";
    fullscreenButton.title = "Enter fullscreen";
  }
});

/* ================================================================
   EVENTS
   ================================================================ */

startButton.addEventListener("click", function () {
  startCamera();
});

stopButton.addEventListener("click", function () {
  stopCamera();

  setStatus("CAMERA STOPPED", "neutral");
  cameraMessage.textContent = "Press START CAMERA to resume.";
});

scanAgainButton.addEventListener("click", function () {
  scanNext();
});

soundButton.addEventListener("click", function () {
  toggleSound();
});

fullscreenButton.addEventListener("click", function () {
  toggleFullscreen();
});

torchButton.addEventListener("click", function () {
  toggleTorch();
});

switchCameraButton.addEventListener("click", function () {
  switchCamera();
});

window.addEventListener("pagehide", function () {
  stopCamera();
});

/* Keep operator name for this browser/gate device. */
try {
  const savedOperator = localStorage.getItem("hplScannerOperator");

  if (savedOperator) {
    operatorInput.value = savedOperator;
  }

  operatorInput.addEventListener("input", function () {
    localStorage.setItem(
      "hplScannerOperator",
      operatorInput.value.trim()
    );
  });
} catch (error) {
  /* Storage may be disabled; scanner still works. */
}

/* Initial state */
if (!window.isSecureContext) {
  setStatus(
    "This scanner must be opened over HTTPS.",
    "error"
  );

  cameraMessage.textContent =
    "HTTPS is required for camera access.";

  setLive(false, "HTTPS REQUIRED");
} else {
  setLive(false, "SCANNER READY");
}
