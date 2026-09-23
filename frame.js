// The capture-frame overlay has no state of its own: it draws whatever the
// main process tells it, and stays click-through so it never gets in the way.
const label = document.getElementById('label');

window.frame.onSet(({ label: text, recording, paused }) => {
  label.textContent = paused ? 'Paused · ' + text : recording ? 'Recording · ' + text : text;
  // The blinking dot means "capturing right now", so not while paused.
  document.body.classList.toggle('recording', !!recording && !paused);
});
