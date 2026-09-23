// Drag-to-select overlay for choosing a custom recording area.
//
// The window covers one display in DIPs, so the drag is measured in DIPs and
// returned window-local; the main process adds the display origin. The size
// label shows physical pixels -- what will actually be captured -- which
// differs from DIPs on a scaled display.

const sel = document.getElementById('sel');
const sizeLabel = document.getElementById('size');
const hint = document.getElementById('hint');

const sf = Number(new URLSearchParams(location.search).get('sf')) || 1;

let startX = 0;
let startY = 0;
let dragging = false;

function rect(e) {
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);
  return { x, y, w, h };
}

// h264 needs even dimensions, so report what will actually be captured.
function physical(n) {
  const p = Math.round(n * sf);
  return p - (p % 2);
}

window.addEventListener('mousedown', (e) => {
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  sel.style.display = 'block';
  hint.style.display = 'none';
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const r = rect(e);
  sel.style.left = r.x + 'px';
  sel.style.top = r.y + 'px';
  sel.style.width = r.w + 'px';
  sel.style.height = r.h + 'px';
  sizeLabel.textContent = physical(r.w) + ' × ' + physical(r.h);
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const r = rect(e);

  // A stray click is not a selection.
  if (r.w < 40 || r.h < 40) {
    sel.style.display = 'none';
    hint.style.display = '';
    return;
  }

  window.region.done({ x: r.x, y: r.y, width: r.w, height: r.h });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.region.cancel();
});
