const els = {
  setup: document.getElementById('setup'),
  interview: document.getElementById('interview'),
  preview: document.getElementById('preview'),
  startBtn: document.getElementById('startBtn'),
  cameraHint: document.getElementById('cameraHint'),
  keyNotice: document.getElementById('keyNotice'),
  question: document.getElementById('question'),
  answer: document.getElementById('answer'),
  doneBtn: document.getElementById('doneBtn'),
  wrapBtn: document.getElementById('wrapBtn'),
  endBtn: document.getElementById('endBtn'),
  status: document.getElementById('status'),
  recDot: document.getElementById('recDot'),
  recTimer: document.getElementById('recTimer'),
  micHint: document.getElementById('micHint'),
  replayBtn: document.getElementById('replayBtn'),
};

let stream;
let recorder;
let chunks = [];
let turns = []; // [{ question, answer, atSec }]
let currentQuestion = '';
let currentAtSec = 0;
let recordStartMs = 0;
let timerInterval = null;
let wrappingUp = false; // true once the closing question has been requested
let thumbBlob = null;
let recognition = null;
let listening = false;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// The interview can only start once BOTH the camera is ready AND a usable xAI key
// is confirmed (see checkKey). This keeps them from starting with a bad key.
let cameraReady = false;
let keyOk = false;
function updateStart() {
  els.startBtn.disabled = !(cameraReady && keyOk);
}

async function initCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    els.preview.srcObject = stream;
    els.cameraHint.textContent = 'Camera and microphone ready.';
    cameraReady = true;
    updateStart();
  } catch (err) {
    els.cameraHint.textContent =
      'Could not access the camera/microphone. Please allow access and reload. (' +
      err.message +
      ')';
  }
}

// Confirm a usable xAI (Grok) key is set before letting the interview start.
// Other providers' keys aren't supported, so we show a friendly reminder.
async function checkKey() {
  try {
    const res = await fetch('/api/key-status');
    const data = await res.json();
    if (data.ok) {
      keyOk = true;
      els.keyNotice.classList.add('hidden');
      updateStart();
      return;
    }
    keyOk = false;
    showKeyProblem(data.reason);
  } catch {
    // If the check itself can't run (e.g., server hiccup), don't hard-block —
    // let them try; the interview will surface any real problem.
    keyOk = true;
    updateStart();
  }
}

function showKeyProblem(reason) {
  const link = 'https://console.x.ai';
  const messages = {
    not_xai:
      '⚠️ This diary only works with an <b>xAI (Grok)</b> API key. Keys from other ' +
      'providers (OpenAI, Anthropic, Google, etc.) aren\'t supported. Get a free xAI ' +
      'key at <a href="' + link + '" target="_blank" rel="noopener">console.x.ai</a> ' +
      'and put it in your <b>.env</b> file.',
    invalid:
      '⚠️ That xAI key didn\'t work — it may be mistyped or turned off. Double-check it ' +
      'in your <b>.env</b> file, or make a new one at ' +
      '<a href="' + link + '" target="_blank" rel="noopener">console.x.ai</a>.',
    missing:
      '⚠️ No API key found. Copy <b>.env.example</b> to a file named <b>.env</b> and paste ' +
      'your xAI (Grok) key — get one free at ' +
      '<a href="' + link + '" target="_blank" rel="noopener">console.x.ai</a>.',
  };
  els.keyNotice.innerHTML = messages[reason] || messages.missing;
  els.keyNotice.classList.remove('hidden');
  updateStart(); // keeps Start disabled while keyOk is false
}

function pickMime() {
  const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const o of opts) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(o)) return o;
  }
  return '';
}

// ---- Recording timer -----------------------------------------------------

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function startTimer() {
  els.recTimer.classList.remove('hidden');
  timerInterval = setInterval(() => {
    els.recTimer.textContent = fmtClock(Date.now() - recordStartMs);
  }, 500);
}
function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

// ---- The AI's voice (xAI Grok TTS via the backend) ------------------------

const VOICE_ID = 'ara';
let currentAudio = null;

// Web Audio mixer so the recorded video captures BOTH the user's mic AND the
// interviewer's voice (which otherwise plays through a separate <audio> element
// that the recorder never sees). Set up on Start; `mixDest` becomes the audio
// track we record. Stays null if the browser can't do it (falls back to mic-only).
let audioCtx = null;
let mixDest = null;

// Route the mic + (later) the interviewer's voice into one mixed audio track.
// Called from startInterview() — the Start click is the user gesture AudioContext needs.
function setupAudioMix() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    audioCtx.resume();
    mixDest = audioCtx.createMediaStreamDestination();
    const micTrack = stream.getAudioTracks()[0];
    if (micTrack) {
      // Mic feeds the recording ONLY (not the speakers), so there's no feedback.
      audioCtx.createMediaStreamSource(new MediaStream([micTrack])).connect(mixDest);
    }
  } catch {
    audioCtx = null;
    mixDest = null; // fall back to recording the plain camera+mic stream
  }
}

function stopSpeaking() {
  try {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
  } catch {
    /* ignore */
  }
  try {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

// Fetch Grok TTS audio for `text`, returning an object-URL for the mp3.
async function fetchTts(text) {
  const res = await fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: VOICE_ID }),
  });
  if (!res.ok) throw new Error('tts ' + res.status);
  return URL.createObjectURL(await res.blob());
}

// Play an audio object-URL, revealing `text` in step with playback via onProgress.
function playAudioUrl(url, text, onProgress) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    currentAudio = audio;
    // Route the interviewer's voice through the mixer so it's recorded too. It
    // still reaches the speakers via audioCtx.destination; mixDest captures it.
    if (audioCtx && mixDest) {
      try {
        const node = audioCtx.createMediaElementSource(audio);
        node.connect(audioCtx.destination);
        node.connect(mixDest);
      } catch {
        /* couldn't tap this element — it just plays directly, as before */
      }
    }
    let raf = null;
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    };
    const tick = () => {
      if (onProgress) {
        let frac;
        if (isFinite(audio.duration) && audio.duration > 0) {
          frac = audio.currentTime / audio.duration;
        } else {
          frac = (audio.currentTime * 15) / Math.max(1, text.length); // ~15 chars/sec
        }
        onProgress(Math.min(1, frac));
      }
      raf = requestAnimationFrame(tick);
    };
    audio.onplay = tick;
    audio.onended = () => {
      stop();
      if (onProgress) onProgress(1);
      resolve();
    };
    audio.onerror = () => {
      stop();
      resolve();
    };
    audio.play().catch(() => {
      stop();
      resolve();
    });
  });
}

// Speak text with the Grok voice; resolves when playback ends. Pass preUrl to
// play already-generated audio (used to preload the opening greeting). onProgress
// reveals the words in step with the voice.
async function speak(text, onProgress, preUrl) {
  stopSpeaking();
  let url = preUrl || null;
  try {
    if (!url) url = await fetchTts(text);
    await playAudioUrl(url, text, onProgress);
    currentAudio = null;
    URL.revokeObjectURL(url);
  } catch {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    await speakBrowser(text, onProgress); // fallback keeps the interview moving
  }
}

// Fallback only: the browser's built-in voice (reveals per spoken word).
function speakBrowser(text, onProgress) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      if (onProgress) onProgress(1);
      return resolve();
    }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.98;
      u.onboundary = (e) => {
        if (onProgress && typeof e.charIndex === 'number') {
          onProgress(Math.min(1, e.charIndex / Math.max(1, text.length)));
        }
      };
      u.onend = () => {
        if (onProgress) onProgress(1);
        resolve();
      };
      u.onerror = () => {
        if (onProgress) onProgress(1);
        resolve();
      };
      window.speechSynthesis.speak(u);
    } catch {
      if (onProgress) onProgress(1);
      resolve();
    }
  });
}

// ---- Live on-screen transcript (browser, instant but rough) ---------------

function startListening() {
  if (!SR) {
    els.micHint.textContent =
      'Live captions need Google Chrome. You can type your answer instead.';
    return;
  }
  listening = true;
  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  let finalText = els.answer.value ? els.answer.value + ' ' : '';
  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' ';
      else interim += r[0].transcript;
    }
    els.answer.value = (finalText + interim).trim();
  };
  recognition.onend = () => {
    if (listening) {
      try {
        recognition.start();
      } catch {
        /* ignore restart races */
      }
    }
  };
  try {
    recognition.start();
  } catch {
    /* ignore */
  }
}

function stopListening() {
  listening = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
    recognition = null;
  }
}

// ---- Accurate transcription (records each answer, sent to xAI STT) --------

let answerRecorder = null;

function startAnswerAudio() {
  try {
    const tracks = stream.getAudioTracks();
    if (!tracks.length || !window.MediaRecorder) return;
    const audioStream = new MediaStream([tracks[0]]);
    const localChunks = [];
    const mt = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : '';
    answerRecorder = new MediaRecorder(audioStream, mt ? { mimeType: mt } : undefined);
    answerRecorder._chunks = localChunks;
    answerRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) localChunks.push(e.data);
    };
    answerRecorder.start();
  } catch {
    answerRecorder = null;
  }
}

function stopAnswerAudio() {
  return new Promise((resolve) => {
    const rec = answerRecorder;
    answerRecorder = null;
    if (!rec || rec.state === 'inactive') return resolve(null);
    rec.onstop = () => resolve(new Blob(rec._chunks, { type: 'audio/webm' }));
    try {
      rec.stop();
    } catch {
      resolve(null);
    }
  });
}

async function transcribeAnswer(blob) {
  if (!blob || blob.size < 1000) return null;
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.text || '').trim();
    return text || null;
  } catch {
    return null;
  }
}

// Commit the current answer WITHOUT waiting on transcription: push the live/typed
// text immediately so the next question can start right away, and transcribe the
// recorded audio accurately in the background — patching the saved transcript when
// it's ready (awaited once at save time).
let pendingTx = [];
async function commitCurrentAnswer() {
  stopListening();
  const audioBlob = await stopAnswerAudio(); // finalizing the recording is instant
  const answer = els.answer.value.trim();
  const hasAudio = audioBlob && audioBlob.size > 4000;
  if (!answer && !hasAudio) return; // nothing was said — skip empty turn
  const idx = turns.length;
  turns.push({ question: currentQuestion, answer, atSec: currentAtSec });
  if (hasAudio) {
    const p = transcribeAnswer(audioBlob)
      .then((accurate) => {
        if (accurate) turns[idx].answer = accurate;
      })
      .catch(() => {});
    pendingTx.push(p);
  }
}

// ---- Thumbnail for the library --------------------------------------------

function captureThumb() {
  try {
    const v = els.preview;
    if (!v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = Math.round((480 * v.videoHeight) / v.videoWidth);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(
      (b) => {
        thumbBlob = b;
      },
      'image/jpeg',
      0.8
    );
  } catch {
    /* thumbnails are best-effort */
  }
}

// ---- The interview loop ----------------------------------------------------

function setBusy(busy) {
  els.doneBtn.disabled = busy;
  els.wrapBtn.disabled = busy || wrappingUp;
  els.replayBtn.disabled = busy;
}

// Reveal the question text in step with how far the voice has spoken.
function revealFraction(text, frac) {
  const n = Math.max(0, Math.min(text.length, Math.round(text.length * (frac || 0))));
  els.question.textContent = text.slice(0, n);
}

async function askQuestion(text, preUrl) {
  currentQuestion = text;
  currentAtSec = Math.round((Date.now() - recordStartMs) / 1000);
  els.question.textContent = ''; // words appear as the voice speaks them
  els.answer.value = '';
  setBusy(true);
  els.status.textContent = '🔊 Speaking…';
  await speak(text, (frac) => revealFraction(text, frac), preUrl);
  els.question.textContent = text; // guarantee the full line is shown at the end
  els.status.textContent = '🎤 Listening…';
  setBusy(false);
  els.replayBtn.classList.remove('hidden');
  startListening();
  startAnswerAudio();
}

async function fetchNextQuestion(wrapUp = false) {
  const history = turns.map((t) => ({ question: t.question, answer: t.answer }));
  const res = await fetch('/api/next-question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history, wrapUp }),
  });
  if (!res.ok) throw new Error('Question request failed');
  const data = await res.json();
  return data.question;
}

// Preload the opening greeting (its question text AND its voice audio) while the
// user is still on the setup screen, so pressing Start begins almost instantly.
let openingPromise = null;
let openingResult = null; // populated the moment the greeting is fully ready (text + voice)
function preloadOpening() {
  if (openingPromise) return;
  openingPromise = (async () => {
    const text = await fetchNextQuestion(); // empty history → opening question
    let url = null;
    try {
      url = await fetchTts(text);
    } catch {
      /* voice will be generated on demand instead */
    }
    return { text, url };
  })()
    .then((r) => {
      openingResult = r; // so Start can tell instantly whether it's ready
      return r;
    })
    .catch(() => null);
}

async function getOpening() {
  if (!openingPromise) preloadOpening();
  const o = await openingPromise;
  if (o && o.text) return o;
  return { text: await fetchNextQuestion(), url: null };
}

// A short, warm line the interviewer can say INSTANTLY the moment you press Start,
// to cover the couple of seconds the real first question might still need — so
// there's never dead air. Its voice is pre-generated at page load, and it's only
// used when the real greeting hasn't finished preloading yet.
const FILLERS = [
  'Hey — good to see you. Settle in for a second.',
  'Hi there. Take a breath and get comfortable.',
  'There you are. Give me just a moment to get set.',
];
const FILLER_TEXT = FILLERS[Math.floor(Math.random() * FILLERS.length)];
let fillerPromise = null;
function preloadFiller() {
  if (fillerPromise) return;
  fillerPromise = fetchTts(FILLER_TEXT).catch(() => null); // → object-URL or null
}

// Speak the filler line (preloaded Grok voice if ready, else the instant browser
// voice as a last resort), revealing its words in step like any question.
async function playFiller() {
  els.status.textContent = '🔊 Speaking…';
  els.question.textContent = '';
  let url = null;
  try {
    url = fillerPromise ? await fillerPromise : null;
  } catch {
    url = null;
  }
  if (url) {
    await speak(FILLER_TEXT, (frac) => revealFraction(FILLER_TEXT, frac), url);
  } else {
    await speakBrowser(FILLER_TEXT, (frac) => revealFraction(FILLER_TEXT, frac));
  }
  els.question.textContent = FILLER_TEXT;
}

async function startInterview() {
  if (!keyOk) {
    checkKey(); // refresh the reminder and stay on the setup screen
    return;
  }
  els.setup.classList.add('hidden');
  els.interview.classList.remove('hidden');
  chunks = [];
  setupAudioMix(); // build the mic + interviewer voice mix (needs this user gesture)
  const mimeType = pickMime();
  // Record the camera's video with the mixed audio (mic + interviewer). If the
  // mixer isn't available, fall back to the plain camera+mic stream.
  const recordStream = mixDest
    ? new MediaStream([...stream.getVideoTracks(), ...mixDest.stream.getAudioTracks()])
    : stream;
  recorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = saveSession;
  recorder.start();
  recordStartMs = Date.now();
  els.recDot.classList.add('recording');
  startTimer();
  setTimeout(captureThumb, 2000); // grab a poster frame for the library
  els.status.textContent = 'Warming up…';
  try {
    // If the real greeting already finished preloading, play it straight away.
    // If not, say a short warm filler first so there's never dead air, then flow
    // into the real first question the instant it's ready.
    if (openingResult && openingResult.url) {
      await askQuestion(openingResult.text, openingResult.url);
    } else {
      await playFiller();
      const opening = await getOpening();
      await askQuestion(opening.text, opening.url);
    }
  } catch (err) {
    els.question.textContent = 'Something went wrong starting the interview: ' + err.message;
  }
}

async function onDone() {
  setBusy(true);
  await commitCurrentAnswer();

  if (wrappingUp) {
    // That was the answer to the closing question — finish up.
    finishAndSave();
    return;
  }

  els.status.textContent = '💭 Thinking…';
  els.question.textContent = '…';
  els.replayBtn.classList.add('hidden');
  try {
    const q = await fetchNextQuestion();
    await askQuestion(q);
  } catch (err) {
    els.question.textContent =
      'Could not get the next question (' +
      err.message +
      '). You can End & save what you have so far.';
    setBusy(false);
  }
}

// "Wrap up": capture the current answer, then the interviewer asks ONE warm
// closing question. Answering it (Done) finishes and saves the entry.
async function onWrapUp() {
  setBusy(true);
  await commitCurrentAnswer();
  wrappingUp = true;
  els.wrapBtn.classList.add('hidden');
  els.doneBtn.textContent = 'Done — finish & save';
  els.status.textContent = 'One last question…';
  els.question.textContent = '…';
  els.replayBtn.classList.add('hidden');
  try {
    const q = await fetchNextQuestion(true);
    await askQuestion(q);
  } catch {
    // If the closing question fails, just save what we have.
    finishAndSave();
  }
}

// Replay the current question (pausing the mic so Ara isn't transcribed).
async function onReplay() {
  if (!currentQuestion) return;
  setBusy(true);
  stopListening();
  try {
    if (answerRecorder && answerRecorder.state === 'recording') answerRecorder.pause();
  } catch {
    /* ignore */
  }
  await speak(currentQuestion);
  try {
    if (answerRecorder && answerRecorder.state === 'paused') answerRecorder.resume();
  } catch {
    /* ignore */
  }
  startListening();
  setBusy(false);
}

function finishAndSave() {
  stopListening();
  stopSpeaking();
  stopTimer();
  els.status.textContent = 'Saving your diary entry…';
  els.doneBtn.disabled = true;
  els.wrapBtn.disabled = true;
  els.endBtn.disabled = true;
  els.recDot.classList.remove('recording');
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

// "End & save now": abrupt stop — still captures a half-given answer if any.
async function onEnd() {
  els.endBtn.disabled = true;
  await commitCurrentAnswer();
  finishAndSave();
}

async function saveSession() {
  try {
    // Let any in-flight accurate transcriptions finish so the saved transcript
    // (and its summary/chapters) use the clean text, not the rough live captions.
    if (pendingTx.length) {
      els.status.textContent = 'Transcribing…';
      await Promise.allSettled(pendingTx);
    }
    els.status.textContent = 'Saving your diary entry…';

    const blob = new Blob(chunks, { type: 'video/webm' });
    const durationSec = Math.round((Date.now() - recordStartMs) / 1000);

    const finRes = await fetch('/api/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: turns }),
    });
    const meta = finRes.ok
      ? await finRes.json()
      : { title: 'Untitled entry', summary: '', chapters: [] };

    const createRes = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        createdAt: new Date().toISOString(),
        durationSec,
        transcript: turns,
        ...meta,
      }),
    });
    const { id, videoName = 'video.webm', appended = false } = await createRes.json();

    await fetch(`/api/sessions/${id}/video?name=${encodeURIComponent(videoName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });

    // Keep the entry's original poster frame — only set a thumbnail for a new entry.
    if (thumbBlob && !appended) {
      await fetch(`/api/sessions/${id}/thumb`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: thumbBlob,
      }).catch(() => {});
    }

    window.location = 'library.html';
  } catch (err) {
    els.status.textContent = 'Could not save: ' + err.message;
  }
}

// ---- Background scene switcher --------------------------------------------
// Two scenes (a cozy room and a spaceship cockpit); the webcam is glued to the
// monitor in whichever one is showing. The CSS vars/shape live in body.bg-*
// classes; here we swap the image + remember the choice, with a fade over the
// swap so it doesn't jump.
const BG_IMG = { room: 'room.webp', space: 'spaceship.webp' };
const BG_BUTTON = { room: '🚀 Spaceship', space: '🏠 Cozy room' }; // shows where you'll go
const BG_ENTER = { room: 'ENTERING · COZY ROOM', space: 'ENTERING · SPACE STATION' };
const bgToggle = document.getElementById('bgToggle');
const bgFade = document.getElementById('bgFade');

function currentBg() {
  return document.body.classList.contains('bg-space') ? 'space' : 'room';
}

function applyBg(theme) {
  if (!BG_IMG[theme]) theme = 'room';
  document.body.classList.remove('bg-room', 'bg-space');
  document.body.classList.add('bg-' + theme);
  const img = document.querySelector('.room-img');
  if (img) img.src = BG_IMG[theme];
  if (bgToggle) bgToggle.textContent = BG_BUTTON[theme];
  try {
    localStorage.setItem('bgTheme', theme);
  } catch {
    /* ignore */
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let switchingBg = false;

async function toggleBg() {
  if (switchingBg) return;
  switchingBg = true;
  const next = currentBg() === 'room' ? 'space' : 'room';
  if (bgFade) {
    bgFade.querySelector('.bg-fade-label').textContent = BG_ENTER[next];
    bgFade.classList.add('show');
    await wait(370); // fade to black
  }
  applyBg(next);
  await wait(240); // let the new scene settle behind the cover
  if (bgFade) {
    bgFade.classList.remove('show');
    await wait(370);
  }
  switchingBg = false;
}

// Restore the last-used scene on load (no fade — just apply it).
try {
  applyBg(localStorage.getItem('bgTheme') || 'room');
} catch {
  applyBg('room');
}

els.startBtn.addEventListener('click', startInterview);
els.doneBtn.addEventListener('click', onDone);
els.wrapBtn.addEventListener('click', onWrapUp);
els.endBtn.addEventListener('click', onEnd);
els.replayBtn.addEventListener('click', onReplay);
if (bgToggle) bgToggle.addEventListener('click', toggleBg);

// Start generating the greeting (its words AND its voice) the instant the page
// opens — in parallel with the camera turning on — so it's ready by the time you
// press Start. The LLM + voice calls don't need the camera, so there's no reason
// to wait for the permission prompt.
preloadOpening();
preloadFiller(); // its instant voice, ready in case Start is clicked very fast
initCamera();
checkKey(); // confirm a usable xAI key before the interview can start
