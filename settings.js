// Runs in the separate settings window. It owns no camera state of its own --
// it reads current values from the main process and sends changes back, which
// the camera window then applies.

const el = {
  dismiss: document.getElementById('dismiss'),
  breakout: document.getElementById('breakout'),
  side: document.getElementById('side'),

  shapeRow: document.getElementById('shape-row'),
  sizeRow: document.getElementById('size-row'),
  widthRow: document.getElementById('width-row'),
  edgeRow: document.getElementById('edge-row'),

  shCircle: document.getElementById('sh-circle'),
  shRounded: document.getElementById('sh-rounded'),
  shSharp: document.getElementById('sh-sharp'),

  szSmall: document.getElementById('sz-small'),
  szMid: document.getElementById('sz-mid'),
  szBig: document.getElementById('sz-big'),

  fifth: document.getElementById('fifth'),
  twofifths: document.getElementById('twofifths'),
  half: document.getElementById('half'),

  edgeLeft: document.getElementById('edge-left'),
  edgeRight: document.getElementById('edge-right'),

  cams: document.getElementById('cams'),

  mirror: document.getElementById('mirror'),
  fx: document.getElementById('fx'),
  visual: document.getElementById('visual'),
  back: document.getElementById('back'),
  record: document.getElementById('record'),
  prLandscape: document.getElementById('pr-landscape'),
  prPortrait: document.getElementById('pr-portrait'),
  prSquare: document.getElementById('pr-square'),
  audio: document.getElementById('audio'),
  folder: document.getElementById('folder'),
  openFolder: document.getElementById('open-folder'),
  pickFolder: document.getElementById('pick-folder'),
  quality: document.getElementById('quality'),
  meta: document.getElementById('meta'),
};

let state = {
  mode: 'breakout',
  shape: 'circle',
  size: 'mid',
  width: 0.2,
  mirror: true,
  deviceId: null,
  edge: 'right',
  quality: '1920x1080',
};

let cameras = [];
let modes = [];
// Held until the main process confirms, so an in-flight state push cannot
// revert a selection the user just made.
let pendingQuality = null;
let renderedModes = '';

function render() {
  const breakout = state.mode === 'breakout';

  el.breakout.classList.toggle('active', breakout);
  el.side.classList.toggle('active', !breakout);

  // Shape and size belong to breakout; width and edge belong to side.
  el.shapeRow.hidden = !breakout;
  el.sizeRow.hidden = !breakout;
  el.widthRow.hidden = breakout;
  el.edgeRow.hidden = breakout;

  el.shCircle.classList.toggle('active', state.shape === 'circle');
  el.shRounded.classList.toggle('active', state.shape === 'rounded');
  el.shSharp.classList.toggle('active', state.shape === 'sharp');

  el.szSmall.classList.toggle('active', state.size === 'small');
  el.szMid.classList.toggle('active', state.size === 'mid');
  el.szBig.classList.toggle('active', state.size === 'big');

  el.fifth.classList.toggle('active', Math.abs(state.width - 0.2) < 0.01);
  el.twofifths.classList.toggle('active', Math.abs(state.width - 0.4) < 0.01);
  el.half.classList.toggle('active', Math.abs(state.width - 0.5) < 0.01);


  el.edgeLeft.classList.toggle('active', state.edge === 'left');
  el.edgeRight.classList.toggle('active', state.edge === 'right');

  el.mirror.classList.toggle('active', state.mirror);




  renderCameras();
  renderQuality();
}


// How the camera reaches Obsoloom: the laptop's own, the phone over USB
// (the Obsoloom Camera app), or the phone through Windows' Connected Camera.
// A dropdown, because the names need room to say which is which.
function renderCameras() {
  const signature = cameras.map((c) => c.deviceId).join('|');
  if (el.cams.dataset.signature !== signature) {
    el.cams.dataset.signature = signature;
    el.cams.textContent = '';
    if (!cameras.length) {
      const o = document.createElement('option');
      o.textContent = 'Detecting…';
      el.cams.appendChild(o);
    }
    for (const cam of cameras) {
      const o = document.createElement('option');
      o.value = cam.deviceId;
      o.textContent = shortLabel(cam.label);
      el.cams.appendChild(o);
    }
  }
  if (state.deviceId) el.cams.value = state.deviceId;
}

el.cams.addEventListener('change', () => {
  if (!el.cams.value) return;
  state.deviceId = el.cams.value;
  window.settings.send('device', el.cams.value);
});

// "Integrated Camera (04f2:b7e0)" is mostly noise in a 240px panel.
function shortLabel(label) {
  if (!label) return 'Camera';
  // A phone paired through Windows' Connected Camera arrives as
  // "<whatever you named your phone> (Windows Virtual Camera)". The device
  // name is the user's own and can be anything; what matters here is that
  // it is the phone.
  if (label === 'Phone USB') return 'Phone — USB cable';
  if (/Windows Virtual Camera/i.test(label)) return 'Phone — Wi-Fi (Windows)';
  // OBS's virtual camera also calls itself one; it is not the phone.
  if (/OBS Virtual Camera/i.test(label)) return 'OBS virtual camera';
  // "Integrated Camera" -> "Laptop camera": say where it is, not how it is wired.
  return label
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*/i, '')
    .replace(/\bIntegrated Camera\b/i, 'Laptop camera')
    .trim() || 'Camera';
}

window.settings.onCameras((payload) => {
  if (Array.isArray(payload.cameras)) cameras = payload.cameras;
  if (payload.deviceId) state.deviceId = payload.deviceId;
  if (payload.resolution) el.meta.textContent = payload.resolution;
  renderCameras();
});

window.settings.onState((next) => {
  if (pendingQuality && next.quality === pendingQuality) pendingQuality = null;
  state = { ...state, ...next };
  render();
});

el.breakout.addEventListener('click', () => {
  state.mode = 'breakout';
  render();
  window.settings.send('mode', 'breakout');
});

el.side.addEventListener('click', () => {
  state.mode = 'side';
  render();
  window.settings.send('mode', 'side');
});

for (const [node, value] of [
  [el.shCircle, 'circle'],
  [el.shRounded, 'rounded'],
  [el.shSharp, 'sharp'],
]) {
  node.addEventListener('click', () => {
    state.shape = value;
    render();
    window.settings.send('shape', value);
  });
}

for (const [node, value] of [
  [el.szSmall, 'small'],
  [el.szMid, 'mid'],
  [el.szBig, 'big'],
]) {
  node.addEventListener('click', () => {
    state.size = value;
    render();
    window.settings.send('size', value);
  });
}

for (const [node, value] of [
  [el.fifth, 0.2],
  [el.twofifths, 0.4],
  [el.half, 0.5],
]) {
  node.addEventListener('click', () => {
    state.width = value;
    render();
    window.settings.send('snap', value);
  });
}

for (const [node, value] of [
  [el.edgeLeft, 'left'],
  [el.edgeRight, 'right'],
]) {
  node.addEventListener('click', () => {
    state.edge = value;
    render();
    window.settings.send('edge', value);
  });
}

el.mirror.addEventListener('click', () => {
  state.mirror = !state.mirror;
  render();
  window.settings.send('mirror', state.mirror);
});




window.settings.onModes((list) => {
  modes = list;
  // Force re-application: the list may have arrived after the state push
  // that carried the saved quality, in which case nothing has selected it.
  renderedModes = '';
  renderQuality();
});

// The mode list and the saved quality arrive on separate channels and can
// land in either order, so selection is applied from state every render
// rather than only when the list appears.
function renderQuality() {
  if (!modes.length) return;

  // Only rebuild when the available list genuinely changed. Rebuilding on
  // every render reset the selection mid-switch.
  const signature = modes.join('|');
  if (signature !== renderedModes) {
    renderedModes = signature;
    el.quality.textContent = '';
    for (const mode of modes) {
      const o = document.createElement('option');
      o.value = mode;
      o.textContent = mode.replace('x', ' × ');
      el.quality.appendChild(o);
    }
  }

  // A pending local choice wins until the main process confirms it, so an
  // in-flight state push cannot revert what was just picked.
  const want = pendingQuality || state.quality;
  if (want && modes.includes(want) && el.quality.value !== want) {
    el.quality.value = want;
  }
}

el.quality.addEventListener('change', () => {
  pendingQuality = el.quality.value;
  state.quality = pendingQuality;
  window.settings.send('quality', pendingQuality);
});

// Live-preview while dragging, persist on release.




el.fx.addEventListener('click', () => window.settings.send('effects'));
el.visual.addEventListener('click', () => {
  window.settings.send('visual');
});

el.back.addEventListener('click', () => window.settings.send('dismiss'));
el.record.addEventListener('click', () => window.settings.send('record'));
el.dismiss.addEventListener('click', () => window.settings.send('dismiss'));

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.settings.send('dismiss');
});

window.settings.ready();
render();
