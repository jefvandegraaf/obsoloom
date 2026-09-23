# Obsoloom

A Loom-style screen recorder for Windows. Your webcam floats on screen as a
circle, a rounded or square window, or a docked side column, and the screen is
recorded locally with ffmpeg. Nothing is uploaded anywhere: recordings are
plain `.mp4` files in a folder you choose.

> Status: pre-release. It works on the author's machine and is being hardened
> before a public release. Expect rough edges.

## Requirements

- Windows 11
- [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) on your `PATH` (a full build,
  for `ddagrab` and `h264_qsv`). The installer does not bundle it yet.
- An Intel GPU with Quick Sync for the current capture path.
- Node.js 20+ to run from source.

## Run from source

```bash
npm install
npm start
```

## Build the installer

```bash
npm run dist
```

The installer is written to `dist/`. It is unsigned, so Windows SmartScreen
will warn on first run: choose **More info → Run anyway**.

## Using it

- **Drag** the camera anywhere. Drag an edge or corner to resize.
- **Controls** (record, settings, close) sit over the camera and fade in as
  the pointer approaches. They are excluded from recordings, so they stay
  usable during a take. Right-click the camera for the same actions.
- **Breakout** is a floating circle, rounded or square window. **Side** is a
  full-height column docked to a screen edge; the window you were last using
  fills the rest of the screen, and is put back when you leave side mode.
- **Recording** captures a 1920x1080 region or a custom area you drag out. A
  red frame marks the captured region; it is visible to you and absent from
  the file. Audio is captured at 48 kHz uncompressed and encoded once, to
  320 kbps AAC in the video.
- **Pause** genuinely stops capture: the take is recorded as segments and
  joined without re-encoding on Stop. Resuming takes about a second while
  the GPU encoder restarts; the panel shows "Resuming…" until it is live.

### Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+Shift+C` | Circle |
| `Ctrl+Alt+Shift+R` | Rounded |
| `Ctrl+Alt+Shift+Q` | Square |
| `Ctrl+Alt+Shift+F` | Side ↔ breakout |
| `Ctrl+Alt+Shift+S` | Spotlight (camera fills the frame) while recording |
| `Ctrl+Alt+Shift+P` | Pause / resume |
| `Ctrl+Alt+Shift+X` | Stop and save |

## Using a phone as the camera

**Over USB, with the Obsoloom Camera app (recommended).** The `android/`
folder is a small Android app that streams the phone's camera down the USB
cable as 1080p H.264, hardware-encoded, with nothing going over any network.
Obsoloom decodes it directly in the camera window: no driver, no virtual
camera, no admin rights. Choose **Settings → Source → Phone — USB cable**;
Obsoloom starts the app on the phone itself. **Visual settings** then drives
the phone's camera: rear/front, zoom (which also moves between lenses),
exposure and exposure lock, mains-flicker suppression, white balance and lock,
automatic or manual focus, and the phone's own sharpening and noise reduction.
Settings are remembered and put back each time the phone connects.

It needs USB debugging enabled on the phone and `adb` on the PC (it is found
automatically if Android Studio is installed). USB debugging lets any PC
you plug the phone into and approve control it, so approve only your own PC
and consider switching it off when you are not recording. The app itself has
no network permission: its stream is a local socket that refuses every
connection except adb's, so other apps on the phone cannot see the camera. To build and install the app,
with a JDK 17+ and the Android SDK:

```bash
cd android
gradle assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Over Wi-Fi, with Windows' Connected Camera.** Any camera Windows exposes
also appears under Source, including an Android phone paired through
Settings → Bluetooth & devices → Mobile devices. It needs no app, but it is
limited to 1280x720 landscape (a phone held upright arrives letterboxed),
exposes no camera controls, and breaks into blocks on a congested 2.4 GHz
link whenever anything moves: put the phone and PC on **5 GHz**.

## Known limitations

- **System audio is not recorded**, only the chosen microphone.
- ffmpeg is not bundled, and the capture path assumes Intel Quick Sync.
- Windows only.

## How it works

- `main.js` — windows, modes, move/resize, capture orchestration.
- `recorder.js` — a take is a list of segments, each a pair of ffmpeg
  processes (GPU video, uncompressed audio) aligned on a shared wall clock
  and muxed; Stop joins the segments without re-encoding.
- `phone-link.js` + `android/` — the phone camera over USB: a framed H.264
  stream through adb port forwarding, decoded with WebCodecs.
- `native.js` — Win32 calls via [koffi](https://koffi.dev): native window
  drags (so Windows snapping works), and placing other apps' windows.
- `hud.*`, `frame.*`, `record.*`, `settings.*`, `visual.*`, `region.*` — the
  satellite windows. Panels and overlays use content protection
  (`WDA_EXCLUDEFROMCAPTURE`) so they never appear in a recording.

## Licence

Copyright (C) 2026 Jef van de Graaf

Obsoloom is released under the MIT License: use it, change it, ship it, sell
it, as long as the copyright notice comes along. It comes with no warranty.
See [LICENSE](LICENSE) for the full text.

The name "Obsoloom" and its logo are not covered by that licence: forks are
welcome, but should use their own name and branding.

Obsoloom runs [ffmpeg](https://ffmpeg.org) as a separate program. ffmpeg is
licensed separately (GPL/LGPL); its source is available from ffmpeg.org.
