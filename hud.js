// The controls, in a content-protected window so they stay usable while
// recording without appearing in the file. Distance from the camera's centre
// drives the opacity, exactly as it did when they lived in the camera page.
// Not `hud`: the preload bridge is window.hud, and a top-level `const hud`
// collides with it, killing this whole script before a single button is
// wired up.
const bar = document.getElementById('hud');
const recBtn = document.getElementById('rec');

const HUD_REST = 0.3;
const FULL = 90;
const FADE = 240;

document.getElementById('rec').addEventListener('click', () => window.hud.record());
document.getElementById('gear').addEventListener('click', () => window.hud.settings());
document.getElementById('quit').addEventListener('click', () => window.hud.close());

// Opacity follows the pointer even when it is outside this small window, so
// the distance is measured by the main process against the camera's centre.
window.hud.onProximity((distance) => {
  if (distance <= FULL) return set(1);
  if (distance >= FADE) return set(HUD_REST);
  const t = (distance - FULL) / (FADE - FULL);
  set(HUD_REST + (1 - HUD_REST) * (1 - t * t));
});

function set(value) {
  bar.style.opacity = String(value);
}

// Our own tooltip, drawn inside this content-protected window. The native
// one lives in a separate top-level window that protection does not cover,
// so it appeared in recordings.
const tip = document.getElementById('tip');

for (const button of document.querySelectorAll('#hud button')) {
  button.addEventListener('mouseenter', () => {
    tip.textContent = button.dataset.label || '';
    tip.classList.add('on');
  });
  button.addEventListener('mouseleave', () => tip.classList.remove('on'));
}

window.hud.onRecording((isRecording) => {
  document.body.classList.toggle('recording', !!isRecording);
  const label = isRecording ? 'Stop recording' : 'Start recording';
  recBtn.dataset.label = label;
  recBtn.setAttribute('aria-label', label);
  if (tip.classList.contains('on') && document.querySelector('#rec:hover')) {
    tip.textContent = label;
  }
});
