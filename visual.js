// Visual settings window.
//
// These are real camera controls, not CSS filters -- they change what the
// sensor produces and therefore what a recording captures. Which controls
// exist depends on the camera, so the panel draws itself from a list the
// main process sends:
//
//   { key, label, type: 'range' | 'select' | 'toggle', value, ... }
//
// A webcam offers a few sliders (whatever its driver exposes); the phone over
// USB offers focus, exposure, white balance, zoom and more. The camera lives
// elsewhere, so this window only sends intents and shows what it is told.

const el = {
  dismiss: document.getElementById('dismiss'),
  controls: document.getElementById('controls'),
  empty: document.getElementById('empty'),
  reset: document.getElementById('reset'),
  back: document.getElementById('back'),
  record: document.getElementById('record'),
};

const WEBCAM_KEYS = ['brightness', 'contrast', 'sharpness', 'saturation'];

let controls = [];
const values = {};

// A webcam reports plain { ranges, values }; turn that into the same list.
function fromWebcam(payload) {
  const list = [];
  for (const key of WEBCAM_KEYS) {
    const r = (payload.ranges || {})[key];
    if (!r) continue;
    list.push({
      key,
      label: key[0].toUpperCase() + key.slice(1),
      type: 'range',
      min: r.min,
      max: r.max,
      step: r.step || 1,
      value: (payload.values || {})[key],
    });
  }
  return list;
}

function display(control, value) {
  if (control.type !== 'range') return '';
  if (typeof value !== 'number') return '—';
  switch (control.format) {
    case 'ev': {
      const ev = value * (control.scale || 1);
      return (ev > 0 ? '+' : '') + ev.toFixed(1) + ' EV';
    }
    case 'zoom':
      return value.toFixed(1) + '×';
    case 'focus':
      // Dioptres: 0 is infinity, larger is closer.
      return value <= 0.01 ? '∞' : Math.round(100 / value) + ' cm';
    default:
      return String(Math.round(value));
  }
}

function enabled(control) {
  if (!control.when) return true;
  return values[control.when.key] === control.when.equals;
}

function send(key, value) {
  values[key] = value;
  window.visual.send('set', { key, value });
  // Some controls only apply in a certain mode (manual focus distance).
  for (const c of controls) {
    if (c.when && c.when.key === key && c.node) c.node.classList.toggle('off', !enabled(c));
  }
}

function build(control) {
  const row = document.createElement('div');
  row.className = 'row';
  control.node = row;

  if (control.type === 'toggle') {
    const label = document.createElement('label');
    label.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!control.value;
    box.addEventListener('change', () => send(control.key, box.checked));
    const text = document.createElement('span');
    text.textContent = control.label;
    label.append(box, text);
    row.appendChild(label);
    return row;
  }

  const head = document.createElement('div');
  head.className = 'head';
  const name = document.createElement('span');
  name.className = 'label';
  name.textContent = control.label;
  const shown = document.createElement('span');
  shown.className = 'value';
  head.append(name, shown);
  row.appendChild(head);

  if (control.type === 'select') {
    const select = document.createElement('select');
    for (const opt of control.options || []) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.label;
      select.appendChild(o);
    }
    select.value = String(control.value);
    select.addEventListener('change', () => {
      const chosen = (control.options || []).find((o) => String(o.value) === select.value);
      send(control.key, chosen ? chosen.value : select.value);
    });
    row.appendChild(select);
    return row;
  }

  const input = document.createElement('input');
  input.type = 'range';
  input.min = control.min;
  input.max = control.max;
  input.step = control.step || 1;
  if (typeof control.value === 'number') input.value = control.value;
  shown.textContent = display(control, control.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    shown.textContent = display(control, v);
    send(control.key, v);
  });
  row.appendChild(input);
  return row;
}

function render() {
  el.controls.textContent = '';
  el.empty.hidden = controls.length > 0;
  for (const c of controls) values[c.key] = c.value;
  for (const c of controls) {
    const row = build(c);
    row.classList.toggle('off', !enabled(c));
    el.controls.appendChild(row);
  }
}

el.reset.addEventListener('click', () => window.visual.send('reset'));
el.dismiss.addEventListener('click', () => window.visual.send('dismiss'));
el.back.addEventListener('click', () => window.visual.send('back'));
el.record.addEventListener('click', () => window.visual.send('record'));

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.visual.send('dismiss');
});

window.visual.onCaps((payload) => {
  controls = Array.isArray(payload.controls) ? payload.controls : fromWebcam(payload);
  el.empty.textContent = payload.note || 'This camera offers no adjustable controls.';
  render();
});

window.visual.ready();
render();
