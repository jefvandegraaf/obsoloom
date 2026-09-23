// The recording window: pre-flight settings, a countdown, then live controls.
//
// Recording used to start silently in the background with no way to tell it
// was running, no way to pause, and no way to abandon a bad take. All three
// live here now, and the recording-specific settings moved out of the camera
// panel where they did not belong.

const el = {
  setup: document.getElementById('setup'),
  live: document.getElementById('live'),

  dismiss: document.getElementById('dismiss'),
  prLandscape: document.getElementById('pr-landscape'),
  prCustom: document.getElementById('pr-custom'),
  customSize: document.getElementById('customSize'),
  screenRow: document.getElementById('screen-row'),
  screens: document.getElementById('screens'),
  audio: document.getElementById('audio'),
  micNote: document.getElementById('micNote'),
  folder: document.getElementById('folder'),
  go: document.getElementById('go'),
  cameraSettings: document.getElementById('camera-settings'),

  statusText: document.getElementById('statusText'),
  elapsed: document.getElementById('elapsed'),
  spotlight: document.getElementById('spotlight'),
  pause: document.getElementById('pause'),
  restart: document.getElementById('restart'),
  stop: document.getElementById('stop'),
};

let state = { preset: 'landscape', folder: null, audioDevice: null };
let countdownTimer = null;
let tickTimer = null;
let startedAt = 0;
let pausedFor = 0;
let pausedAt = 0;
let paused = false;

// Only worth showing when there is a choice to make.
function renderScreens() {
  const list = state.displays || [];
  el.screenRow.hidden = list.length < 2;
  if (list.length < 2) return;

  el.screens.textContent = '';
  for (const d of list) {
    const b = document.createElement('button');
    b.textContent = d.label;
    const small = document.createElement('small');
    small.textContent = d.native;
    b.appendChild(small);
    b.classList.toggle('active', d.id === state.displayId);
    b.addEventListener('click', () => {
      state.displayId = d.id;
      renderScreens();
      window.rec.send('display', d.id);
    });
    el.screens.appendChild(b);
  }
}

function renderSetup() {
  el.prLandscape.classList.toggle('active', state.preset === 'landscape');
  el.prCustom.classList.toggle('active', state.preset === 'custom');
  el.customSize.textContent = state.customLabel || 'pick area';
  el.folder.textContent = state.folder || 'Choose folder…';
  el.micNote.hidden = !state.audioWarning;
  el.micNote.textContent = state.audioWarning || '';
  renderScreens();
  el.go.disabled = false;
}


function show(which) {
  if (which === 'setup' && countdownTimer) stopCountdown();
  el.setup.hidden = which !== 'setup';
  el.live.hidden = which !== 'live';
}

// ---------- pre-flight ----------

el.prLandscape.addEventListener('click', () => {
  state.preset = 'landscape';
  renderSetup();
  window.rec.send('preset', 'landscape');
});

// Custom opens a drag-to-select overlay across the screen, the same gesture
// as the Snipping Tool.
el.prCustom.addEventListener('click', () => window.rec.send('pickRegion'));

el.folder.addEventListener('click', () => window.rec.send('folder'));


el.audio.addEventListener('change', () =>
  window.rec.send('audio', el.audio.value || null)
);

el.dismiss.addEventListener('click', () => {
  stopCountdown();
  window.rec.send('cancel');
});
// The same two panels before and during a take: they are hidden from the
// capture, so adjusting the camera mid-recording leaves no trace.
for (const [id, action] of [
  ['camera-settings', 'cameraSettings'],
  ['visual-settings', 'visualSettings'],
  ['live-camera-settings', 'cameraSettings'],
  ['live-visual-settings', 'visualSettings'],
]) {
  document.getElementById(id).addEventListener('click', () => window.rec.send(action));
}

el.go.addEventListener('click', () => {
  if (!state.folder) {
    window.rec.send('folder');
    return;
  }
  startCountdown();
});

// ---------- countdown ----------

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  document.body.classList.remove('counting');
  window.rec.send('countdown', null);
}

function startCountdown() {
  // Never let two countdowns run at once.
  if (countdownTimer) clearInterval(countdownTimer);
  let n = 3;
  // Drawn on the camera window, over the face -- that is where you are
  // looking while getting ready, not at this panel.
  window.rec.send('countdown', n);

  // Show the live controls immediately, disabled, rather than a black panel.
  document.body.classList.add('counting');
  el.statusText.textContent = 'Get ready…';
  el.elapsed.textContent = '00:00';
  show('live');

  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      window.rec.send('begin');
      return;
    }
    window.rec.send('countdown', n);
  }, 1000);
}

// ---------- live ----------

function fmt(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function startTicking() {
  stopTicking();
  tickTimer = setInterval(() => {
    if (paused) return;
    el.elapsed.textContent = fmt(Date.now() - startedAt - pausedFor);
  }, 250);
}

function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

// Pause is real: the main process ends or starts a recording segment, which
// takes a moment either way, and reports back. This only asks.
el.pause.addEventListener('click', () => {
  el.pause.disabled = true;
  window.rec.send('pause');
});

// Idempotent, so a repeated report cannot double-count paused time.
function applyPaused(next) {
  if (next !== paused) {
    paused = next;
    if (paused) pausedAt = Date.now();
    else pausedFor += Date.now() - pausedAt;
  }
  document.body.classList.toggle('paused', paused);
  el.pause.textContent = paused ? 'Resume' : 'Pause';
}

el.spotlight.addEventListener('click', () => window.rec.send('spotlight'));
el.restart.addEventListener('click', () => window.rec.send('restart'));
el.stop.addEventListener('click', () => window.rec.send('stop'));

// ---------- from the main process ----------

window.rec.onState((next) => {
  state = { ...state, ...next };
  renderSetup();
});

// 'Headset (WH-1000XM4)' -> 'WH-1000XM4'. The bracketed half identifies the
// device; stripping it (as this used to) collapsed both headsets to the same
// useless label, "Headset".
function micLabel(raw) {
  const inner = raw.match(/\(([^)]+)\)/);
  if (!inner) return raw;
  // Windows prefixes enumeration numbers like "2- " onto the inner name.
  const name = inner[1].replace(/^\d+-\s*/, '').trim();
  return name || raw;
}

window.rec.onAudio((devices) => {
  el.audio.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'No audio';
  el.audio.appendChild(none);
  for (const d of devices) {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = micLabel(d);
    if (d === state.audioDevice) o.selected = true;
    el.audio.appendChild(o);
  }
});

window.rec.onPaused((p) => {
  el.pause.disabled = !!p.pending;

  if (p.pending === 'pausing') {
    // Freeze the clock the moment Pause is pressed, not when it lands.
    applyPaused(true);
    el.statusText.textContent = 'Pausing…';
    return;
  }
  if (p.pending === 'resuming') {
    // The clock stays frozen until capture is genuinely live again.
    el.statusText.textContent = 'Resuming…';
    return;
  }

  applyPaused(!!p.paused);
  el.statusText.textContent = paused ? 'Paused' : 'Recording';
  if (p.error) alert(p.error);
});

window.rec.onRecording((info) => {
  // Spotlight state arrives on its own, without a recording transition.
  if (typeof info.spotlight === 'boolean') {
    document.body.classList.toggle('spotlit', info.spotlight);
    el.spotlight.textContent = info.spotlight ? 'Back to screen' : 'Spotlight me';
    return;
  }
  if (info.error) {
    show('setup');
    el.folder.textContent = state.folder || 'Choose folder…';
    el.go.textContent = 'Start recording';
    alert(info.error);
    return;
  }

  if (info.recording) {
    document.body.classList.remove('counting');
    paused = false;
    pausedFor = 0;
    document.body.classList.remove('paused');
    el.pause.textContent = 'Pause';
    el.statusText.textContent = 'Recording';
    startedAt = Date.now();
    el.elapsed.textContent = '00:00';
    show('live');
    startTicking();
  } else {
    stopTicking();
    show('setup');
  }
});

function cancelCountdown() {
  if (!countdownTimer) return;
  stopCountdown();
  show('setup');
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelCountdown();
});

window.rec.onCancelCountdown(cancelCountdown);

// The camera window's red button while this panel is open.
window.rec.onGo(() => {
  if (countdownTimer || el.setup.hidden) return;
  el.go.click();
});

window.rec.ready();
renderSetup();
show('setup');
