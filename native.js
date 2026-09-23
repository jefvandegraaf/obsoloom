// Win32 calls Electron does not expose, via koffi (no compiler needed).
//
// beginMove hands an in-progress mouse drag to Windows as if the user had
// grabbed a title bar. From then on it is a normal window drag: Snap
// Layouts at the top edge, Snap Assist at the sides, the lot. The window is
// frameless and has no caption of its own, and a drag done by setPosition
// never triggers any of that.
let user32 = null;

function load() {
  if (user32 !== null) return user32;
  try {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    const dwm = koffi.load('dwmapi.dll');
    user32 = {
      ReleaseCapture: lib.func('bool ReleaseCapture()'),
      PostMessageW: lib.func(
        'bool PostMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'
      ),
      SendMessageW: lib.func(
        'intptr_t SendMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'
      ),
      DwmSetWindowAttribute: dwm.func(
        'int DwmSetWindowAttribute(uintptr_t hwnd, uint32_t attr, void *value, uint32_t size)'
      ),
      DwmGetWindowAttribute: dwm.func(
        'int DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attr, _Out_ void *value, uint32_t size)'
      ),
      // Listing and placing other applications' windows, for side mode.
      EnumWindows: lib.func('bool EnumWindows(void *cb, intptr_t lParam)'),
      IsWindowVisible: lib.func('bool IsWindowVisible(uintptr_t hwnd)'),
      IsWindow: lib.func('bool IsWindow(uintptr_t hwnd)'),
      IsIconic: lib.func('bool IsIconic(uintptr_t hwnd)'),
      IsZoomed: lib.func('bool IsZoomed(uintptr_t hwnd)'),
      ShowWindow: lib.func('bool ShowWindow(uintptr_t hwnd, int cmd)'),
      GetWindowTextW: lib.func(
        'int GetWindowTextW(uintptr_t hwnd, _Out_ uint16_t *buf, int max)'
      ),
      GetWindowTextLengthW: lib.func('int GetWindowTextLengthW(uintptr_t hwnd)'),
      GetWindowLongW: lib.func('int32_t GetWindowLongW(uintptr_t hwnd, int index)'),
      GetWindowRect: lib.func('bool GetWindowRect(uintptr_t hwnd, _Out_ int32_t *rect)'),
      // GetWindowRect reports where a maximized window currently is; the
      // placement carries the size it will return to when un-maximized.
      GetWindowPlacement: lib.func(
        'bool GetWindowPlacement(uintptr_t hwnd, _Inout_ uint8_t *wp)'
      ),
      SetWindowPos: lib.func(
        'bool SetWindowPos(uintptr_t hwnd, uintptr_t after, int x, int y, int cx, int cy, uint32_t flags)'
      ),
      GetForegroundWindow: lib.func('uintptr_t GetForegroundWindow()'),
      GetWindowThreadProcessId: lib.func(
        'uint32_t GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)'
      ),
      koffi,
    };
  } catch (err) {
    console.warn('native: koffi unavailable, falling back:', err && err.message);
    user32 = false;
  }
  return user32;
}

// Windows 11 draws the corners itself for an opaque frameless window; this
// switches between its rounded and square styles without recreating it.
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_DONOTROUND = 1;
const DWMWCP_ROUND = 2;

function setCorners(win, rounded) {
  const u = load();
  if (!u) return false;
  try {
    const value = Buffer.alloc(4);
    value.writeUInt32LE(rounded ? DWMWCP_ROUND : DWMWCP_DONOTROUND, 0);
    return u.DwmSetWindowAttribute(hwndOf(win), DWMWA_WINDOW_CORNER_PREFERENCE, value, 4) === 0;
  } catch {
    return false;
  }
}

const WM_NCLBUTTONDOWN = 0x00a1;
const WM_SYSCOMMAND = 0x0112;
const HTCAPTION = 2;
// SC_MOVE with the "started from the mouse" bit: DefWindowProc runs the
// standard move loop tracking the cursor from where it already is.
const SC_DRAGMOVE = 0xf012;

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

// Call while the left button is held down over the window. Posted, not
// sent: a sent WM_SYSCOMMAND runs the move loop inside the call and blocks
// this process until the button comes up.
//
// Windows will not snap a transparent (layered) window, whatever the route;
// only opaque windows get Snap Layouts and edge snapping.
function beginMove(win, mode = 'sc-post') {
  const u = load();
  if (!u) return false;
  try {
    const hwnd = hwndOf(win);
    // Chromium holds mouse capture from the mousedown; the move loop needs it.
    u.ReleaseCapture();
    if (mode === 'nc-post') return !!u.PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
    if (mode === 'sc-post') return !!u.PostMessageW(hwnd, WM_SYSCOMMAND, SC_DRAGMOVE, 0);
    u.SendMessageW(hwnd, WM_SYSCOMMAND, SC_DRAGMOVE, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Other applications' windows
//
// Side mode docks the camera to a fifth of the screen and gives the rest to
// whichever window you were last using; breakout hands that window the whole
// screen and floats the camera on top. Everything moved is recorded first and
// put back afterwards.
// ---------------------------------------------------------------------------
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const DWMWA_CLOAKED = 14;
const SW_RESTORE = 9;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;

function titleOf(u, hwnd) {
  const len = u.GetWindowTextLengthW(hwnd);
  if (!len) return '';
  const buf = Buffer.alloc((len + 1) * 2);
  u.GetWindowTextW(hwnd, buf, len + 1);
  return buf.toString('ucs2').replace(/\0.*$/, '');
}

function rectOf(u, hwnd) {
  const r = Buffer.alloc(16);
  if (!u.GetWindowRect(hwnd, r)) return null;
  const x = r.readInt32LE(0);
  const y = r.readInt32LE(4);
  return { x, y, width: r.readInt32LE(8) - x, height: r.readInt32LE(12) - y };
}

// A window worth offering: visible, titled, not a tool palette, and not one
// of the cloaked shells UWP leaves lying around.
function isCandidate(u, hwnd, ownPids) {
  if (!u.IsWindowVisible(hwnd)) return false;
  if (!u.GetWindowTextLengthW(hwnd)) return false;
  if (u.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return false;
  const cloaked = Buffer.alloc(4);
  u.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4);
  if (cloaked.readUInt32LE(0) !== 0) return false;
  if (ownPids && ownPids.length) {
    const pid = Buffer.alloc(4);
    u.GetWindowThreadProcessId(hwnd, pid);
    if (ownPids.includes(pid.readUInt32LE(0))) return false;
  }
  return true;
}

function listWindows(ownPids = []) {
  const u = load();
  if (!u) return [];
  const out = [];
  try {
    // Declared once: koffi throws on a second declaration of the same name,
    // which made every call after the first return an empty list.
    if (!u.enumProto) {
      u.enumProto = u.koffi.proto('bool __stdcall ObsEnumCb(uintptr_t hwnd, intptr_t lParam)');
    }
    const proto = u.enumProto;
    const cb = u.koffi.register((hwnd) => {
      if (isCandidate(u, hwnd, ownPids)) {
        out.push({ id: String(hwnd), title: titleOf(u, hwnd), minimized: !!u.IsIconic(hwnd) });
      }
      return true;
    }, u.koffi.pointer(proto));
    u.EnumWindows(cb, 0);
    u.koffi.unregister(cb);
  } catch {
    return [];
  }
  return out;
}

// The window in front right now, if it belongs to another app.
function foregroundWindow(ownPids = []) {
  const u = load();
  if (!u) return null;
  try {
    const hwnd = u.GetForegroundWindow();
    if (!hwnd || !isCandidate(u, hwnd, ownPids)) return null;
    return { id: String(hwnd), title: titleOf(u, hwnd) };
  } catch {
    return null;
  }
}

// WINDOWPLACEMENT: length, flags, showCmd, 2x POINT, then the normal RECT
// (the size the window returns to when neither maximized nor minimized).
// That RECT starts at byte 28 in the 44-byte struct.
function normalRect(u, hwnd) {
  const wp = Buffer.alloc(44);
  wp.writeUInt32LE(44, 0);
  if (!u.GetWindowPlacement(hwnd, wp)) return null;
  const x = wp.readInt32LE(28);
  const y = wp.readInt32LE(32);
  return { x, y, width: wp.readInt32LE(36) - x, height: wp.readInt32LE(40) - y };
}

function getPlacement(id) {
  const u = load();
  if (!u) return null;
  const hwnd = Number(id);
  try {
    if (!u.IsWindow(hwnd)) return null;
    const maximized = !!u.IsZoomed(hwnd);
    const minimized = !!u.IsIconic(hwnd);
    // Only a plain window's on-screen rect is its real one; for the other
    // two states ask for the restore rect.
    const rect = maximized || minimized ? normalRect(u, hwnd) : rectOf(u, hwnd);
    return { id: String(hwnd), title: titleOf(u, hwnd), rect, maximized, minimized };
  } catch {
    return null;
  }
}

// Move a window to an exact rectangle, in physical pixels.
//
// A maximized or minimized window ignores SetWindowPos until it is restored,
// so that comes first. And when a move takes a window onto a monitor with a
// different DPI, Windows rescales it for the destination -- ask for 1536 on
// the way to a 125% screen and you get 1843. The size is simply reapplied
// once the window is already there, which is a no-op when no rescale
// happened.
function placeWindow(id, rect) {
  const u = load();
  if (!u) return false;
  const hwnd = Number(id);
  const want = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  try {
    if (!u.IsWindow(hwnd) || !u.IsWindowVisible(hwnd)) return false;
    if (u.IsIconic(hwnd) || u.IsZoomed(hwnd)) u.ShowWindow(hwnd, SW_RESTORE);

    const flags = SWP_NOZORDER | SWP_NOACTIVATE;
    if (!u.SetWindowPos(hwnd, 0, want.x, want.y, want.width, want.height, flags)) {
      return false;
    }
    const got = rectOf(u, hwnd);
    if (got && (Math.abs(got.width - want.width) > 2 || Math.abs(got.height - want.height) > 2)) {
      u.SetWindowPos(hwnd, 0, want.x, want.y, want.width, want.height, flags);
    }
    return true;
  } catch {
    return false;
  }
}

// Put a window back exactly as getPlacement found it.
function restoreWindow(saved) {
  const u = load();
  if (!u || !saved) return false;
  const hwnd = Number(saved.id);
  try {
    if (!u.IsWindow(hwnd)) return false;

    // A window that was minimized has no meaningful rectangle -- Windows
    // parks it off-screen at -25600. Send it back to the taskbar instead of
    // writing that nonsense into its real placement.
    if (saved.minimized) {
      u.ShowWindow(hwnd, 6); // SW_MINIMIZE
      return true;
    }
    if (!saved.rect) return false;

    if (saved.maximized) {
      // Restore the pre-maximize rect first, so un-maximizing later lands
      // where it used to, then maximize again.
      u.ShowWindow(hwnd, SW_RESTORE);
      u.SetWindowPos(hwnd, 0, saved.rect.x, saved.rect.y, saved.rect.width, saved.rect.height, SWP_NOZORDER | SWP_NOACTIVATE);
      u.ShowWindow(hwnd, 3); // SW_MAXIMIZE
      return true;
    }
    return !!u.SetWindowPos(
      hwnd, 0, saved.rect.x, saved.rect.y, saved.rect.width, saved.rect.height,
      SWP_NOZORDER | SWP_NOACTIVATE
    );
  } catch {
    return false;
  }
}

module.exports = {
  beginMove,
  setCorners,
  listWindows,
  foregroundWindow,
  getPlacement,
  placeWindow,
  restoreWindow,
  available: () => !!load(),
};
