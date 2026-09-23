// Screen recording via ffmpeg, as two processes.
//
// Video: ddagrab (GPU desktop duplication) -> hwmap onto Quick Sync ->
// vpp_qsv crop -> h264_qsv. The frames never leave the graphics card; the
// hwdownload + libx264 path measured 4.8fps at 1080p on this machine.
//
// Audio: its own ffmpeg. Feeding dshow audio into the video process halved
// the frame rate (29 -> 16fps) because the audio demuxer blocks the shared
// pipeline. The two files are muxed when recording stops, aligned on the
// wall-clock moment each stream actually began.

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Kept for callers that still read the preset table.
const PRESETS = {
  landscape: { width: 1920, height: 1080, label: '1920x1080' },
};

// Resolve ffmpeg once: PATH first, then whatever `where` finds.
let ffmpegPath = null;
function resolveFfmpeg(cb) {
  if (ffmpegPath) return cb(ffmpegPath);
  // `where` would list a copy in the current folder first; $PATH: limits
  // it to PATH, and only an absolute path is accepted back.
  const where = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  execFile(where, ['$PATH:ffmpeg.exe'], { timeout: 4000 }, (err, stdout) => {
    const found = !err && stdout ? stdout.trim().split(/\r?\n/)[0] : '';
    ffmpegPath = path.isAbsolute(found) ? found : 'ffmpeg';
    cb(ffmpegPath);
  });
}

function listAudioDevices(cb) {
  resolveFfmpeg((bin) => {
    execFile(
      bin,
      ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'],
      { timeout: 8000 },
      (_err, _stdout, stderr) => {
        const devices = [];
        // Lines look like: [...] "Microphone Array (...)" (audio)
        const re = /"([^"]+)"\s+\(audio\)/g;
        let m;
        while ((m = re.exec(stderr || '')) !== null) devices.push(m[1]);
        cb(devices);
      }
    );
  });
}

// Try to open a microphone for a moment. Another app holding it, or a device
// that has gone away, shows up here before a take is wasted on silence.
function probeAudioDevice(device, cb) {
  if (!device) return cb(true, '');
  resolveFfmpeg((bin) => {
    execFile(
      bin,
      [
        '-hide_banner', '-loglevel', 'error', '-nostats',
        '-f', 'dshow', '-audio_buffer_size', '30', '-i', `audio=${device}`,
        '-t', '0.2', '-f', 'null', '-',
      ],
      { timeout: 8000, windowsHide: true },
      (err, _stdout, stderr) => {
        const tail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        cb(!err, err ? tail.replace(/^\[[^\]]*\]\s*/, '') : '');
      }
    );
  });
}

function timestampName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    'obsoloom-' +
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.mp4`
  );
}

function spawnFfmpeg(bin, args) {
  return spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

function exitPromise(proc) {
  return new Promise((resolve) => {
    proc.once('exit', (code) => resolve(code));
    proc.once('error', () => resolve(-1));
  });
}

// ---------------------------------------------------------------------------
// A take is a list of segments.
//
// Windows cannot suspend ffmpeg, so a real pause is done by ending the
// current segment cleanly and starting a new one on resume. Each segment is
// a pair of ffmpeg processes (video, audio) muxed and aligned on its own;
// Stop joins the finished segments without re-encoding.
//
// Alignment within a segment: both processes share a wall-clock epoch.
//   - Video frames are stamped (RTCTIME - epoch) by setpts, so the video
//     file's own start_time IS the first frame's moment, exactly.
//   - Audio starts at zero; the moment its zero occurred is measured from
//     ffmpeg's -progress output (now - out_time).
// Estimating the VIDEO start from -progress was tried and is wrong by about
// half a second: its timestamps count from the epoch, not from zero, so
// "now - out_time" identifies the epoch rather than the first frame.
// ---------------------------------------------------------------------------

function probe(bin, args, cb) {
  execFile(
    bin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'),
    ['-v', 'error', ...args],
    { timeout: 10000, windowsHide: true },
    (err, stdout) => cb(err ? null : String(stdout || '').trim())
  );
}

function probeNumber(bin, args, cb) {
  probe(bin, args, (out) => {
    const v = out === null ? NaN : parseFloat(out.split(/\r?\n/)[0]);
    cb(Number.isNaN(v) ? null : v);
  });
}

function run(bin, args, cb) {
  const p = spawnFfmpeg(bin, args);
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  p.on('exit', (code) => cb(code === 0));
  p.on('error', () => cb(false));
}

function remove(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* a leftover piece is harmless */
  }
}

// ffmpeg's clean shutdown: 'q' on stdin finalises the container. Killing
// outright leaves an mp4 without its moov atom.
function quit(p) {
  if (!p || p.exitCode !== null) return;
  try {
    p.stdin.write('q');
    p.stdin.end();
  } catch {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}

// When did the audio stream's zero occur? now - out_time, from -progress.
function watchAudioStart(proc, onStart) {
  let buf = '';
  let done = false;
  proc.stdout.on('data', (chunk) => {
    if (done) return; // keep draining so the pipe never backs up
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = /^out_time_us=(\d+)$/.exec(line);
      if (m && Number(m[1]) > 0) {
        done = true;
        onStart(Date.now() - Number(m[1]) / 1000);
        return;
      }
    }
  });
}

function startSegment(s, cb) {
  const o = s.opts;
  const n = s.segments.length + 1;
  const videoFile = `${s.base}.part${n}.video.mp4`;
  const audioFile = o.audioDevice ? `${s.base}.part${n}.audio.wav` : null;
  const epochUs = Date.now() * 1000;

  const videoArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostats',
    '-f', 'lavfi',
    '-i', `ddagrab=output_idx=${o.displayIndex}:framerate=${o.fps}:draw_mouse=1`,
    // Stamp each frame with the wall clock as it arrives, then crop on the
    // GPU. Offsets are physical pixels from the display origin.
    '-vf',
    `settb=AVTB,setpts=(RTCTIME-${epochUs})/(TB*1000000),` +
      `hwmap=derive_device=qsv,format=qsv,vpp_qsv=cw=${o.crop.w}:ch=${o.crop.h}:cx=${o.crop.x}:cy=${o.crop.y}` +
      // Say what the RGB desktop becomes. Left alone, the file came out tagged
      // full-range with an RGB matrix, and players showed black (26) as grey
      // (39): every recording looked faded.
      ':format=nv12:out_range=tv:out_color_matrix=bt709' +
      ':out_color_primaries=bt709:out_color_transfer=bt709',
    // ddagrab paces itself; re-timing onto a rigid grid padded 81% of a real
    // recording with duplicate frames.
    '-vsync', 'passthrough',
    '-c:v', 'h264_qsv',
    // Quality 16 at the medium preset: a face holds its hair and skin detail
    // (22/veryfast smeared them) and the GPU still delivers every frame.
    '-preset', 'medium',
    '-global_quality', '16',
    '-bf', '0',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    // A keyframe every two seconds: YouTube and editors seek on these.
    '-g', String(o.fps * 2),
    '-y', videoFile,
  ];

  const audioArgs = audioFile
    ? [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostats',
        '-progress', 'pipe:1',
        '-stats_period', '0.1',
        // A 30ms device buffer keeps arrival close to capture (the device
        // default can be 500ms).
        '-audio_buffer_size', '30',
        // 48kHz because that is what video work runs at; asked for
        // explicitly rather than left to the device's default.
        '-sample_rate', '48000',
        '-sample_size', '16',
        '-f', 'dshow',
        '-i', `audio=${o.audioDevice}`,
        // Uncompressed: lossy encoding at capture is the one thing an editor
        // cannot undo. Encoded once, at the mux.
        '-c:a', 'pcm_s16le',
        '-ar', '48000',
        '-y', audioFile,
      ]
    : null;

  resolveFfmpeg((bin) => {
    const videoProc = spawnFfmpeg(bin, videoArgs);
    const audioProc = audioArgs ? spawnFfmpeg(bin, audioArgs) : null;

    const seg = {
      n,
      videoProc,
      audioProc,
      videoFile,
      audioFile,
      epochUs,
      audioStartedAt: null,
      audioLost: false,
      closing: false,
      videoExit: exitPromise(videoProc),
      audioExit: audioProc ? exitPromise(audioProc) : Promise.resolve(0),
    };
    s.current = seg;

    let stderr = '';
    videoProc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    videoProc.stdout.on('data', () => {});

    let audioStderr = '';
    if (audioProc) {
      audioProc.stderr.on('data', (d) => {
        audioStderr += d.toString();
        if (audioStderr.length > 4000) audioStderr = audioStderr.slice(-2000);
      });
      watchAudioStart(audioProc, (t0) => {
        seg.audioStartedAt = t0;
      });
      // A mic that vanishes mid-take ends this process early; the segment
      // then finishes with silence rather than failing the take.
      seg.audioExit.then(() => {
        if (!seg.closing) seg.audioLost = true;
      });
    }

    // Fires exactly once. Dying in the first second means the encoder, the
    // display index or the mic is wrong; surviving it means capture is
    // genuinely running.
    let settled = false;
    let timer = null;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        seg.closing = true;
        quit(videoProc);
        quit(audioProc);
        if (s.current === seg) s.current = null;
        Promise.all([seg.videoExit, seg.audioExit]).then(() => {
          remove(videoFile);
          remove(audioFile);
        });
      }
      cb(err || null);
    };

    videoProc.once('error', (err) => settle(new Error(`ffmpeg not runnable: ${err.message}`)));

    seg.videoExit.then((code) => {
      if (!settled) {
        settle(
          new Error(
            `ffmpeg exited (${code}) before recording began: ${stderr.slice(-400) || 'no output'}`
          )
        );
      }
    });

    timer = setTimeout(() => {
      if (videoProc.exitCode !== null) return;
      if (audioProc && audioProc.exitCode !== null) {
        const why = audioStderr.trim().split(/\r?\n/).filter(Boolean).pop() || 'no details';
        return settle(
          new Error(
            `Microphone "${o.audioDevice}" could not be opened. ` +
              `Another app (OBS, Teams, a browser tab) may be using it.\n` +
              why.replace(/^\[[^\]]*\]\s*/, '')
          )
        );
      }
      settle(null);
    }, 1200);
  });
}

// End the running segment cleanly, mux and align it, and add it to the take.
function finishSegment(s, cb) {
  const seg = s.current;
  if (!seg) return cb();
  s.current = null;
  seg.closing = true;
  quit(seg.videoProc);
  quit(seg.audioProc);

  const both = Promise.all([seg.videoExit, seg.audioExit]);
  const patience = new Promise((r) => setTimeout(r, 8000));
  Promise.race([both, patience]).then(() => {
    for (const p of [seg.videoProc, seg.audioProc]) {
      if (p && p.exitCode === null) {
        try {
          p.kill();
        } catch {
          /* nothing to do */
        }
      }
    }
    resolveFfmpeg((bin) => muxSegment(bin, s, seg, cb));
  });
}

function muxSegment(bin, s, seg, cb) {
  const merged = `${s.base}.part${seg.n}.mp4`;
  const wantsAudio = !!s.opts.audioDevice;
  const hasAudio = !!seg.audioFile && fs.existsSync(seg.audioFile) && !seg.audioLost;

  // The video's start_time is its first frame's moment relative to the epoch.
  probeNumber(bin, ['-show_entries', 'stream=start_time', '-of', 'csv=p=0', seg.videoFile], (v0) => {
    if (v0 === null) {
      // No readable video: nothing to keep from this segment.
      remove(seg.videoFile);
      remove(seg.audioFile);
      return cb();
    }

    const videoStartMs = seg.epochUs / 1000 + v0 * 1000;
    const offset =
      hasAudio && seg.audioStartedAt != null ? (seg.audioStartedAt - videoStartMs) / 1000 : 0;
    syncLog.push({ segment: seg.n, videoFirstFrame: +v0.toFixed(3), offset: +offset.toFixed(3) });

    const audioIn = [];
    if (hasAudio) {
      // Audio began after the first frame: hold it back. Before: trim it.
      if (offset > 0.001) audioIn.push('-itsoffset', offset.toFixed(4));
      else if (offset < -0.001) audioIn.push('-ss', (-offset).toFixed(4));
      audioIn.push('-i', seg.audioFile);
    } else if (wantsAudio) {
      // The mic dropped out for this segment. Silence keeps every segment
      // the same shape, which joining without re-encoding requires.
      audioIn.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    }

    const args = ['-hide_banner', '-loglevel', 'error', '-i', seg.videoFile, ...audioIn, '-map', '0:v:0'];
    if (audioIn.length) {
      // The only lossy audio step, and it happens once: 320k AAC at 48kHz.
      args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2', '-shortest');
    }
    args.push('-c:v', 'copy', '-y', merged);

    run(bin, args, (ok) => {
      if (!ok) {
        // Keep the raw video rather than lose the segment.
        try {
          fs.renameSync(seg.videoFile, merged);
        } catch {
          return cb();
        }
      } else {
        remove(seg.videoFile);
      }

      s.segments.push({ n: seg.n, file: merged });
      remove(seg.audioFile);
      cb();
    });
  });
}

// Join finished segments into one file. Same codec and settings throughout,
// so this is a copy, not a re-encode.
function joinFiles(bin, files, out, extraArgs, cb) {
  if (files.length === 1) {
    try {
      remove(out);
      fs.renameSync(files[0], out);
      return cb(true);
    } catch {
      return cb(false);
    }
  }
  const list = `${out}.list.txt`;
  fs.writeFileSync(
    list,
    files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
  );
  run(
    bin,
    ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...extraArgs, '-y', out],
    (ok) => {
      remove(list);
      if (ok) files.forEach(remove);
      cb(ok);
    }
  );
}

let session = null;
let syncLog = [];

function isRecording() {
  return !!(session && !session.stopping);
}

function isPaused() {
  return !!(session && session.paused && !session.stopping);
}

// crop is in physical pixels relative to the display's top-left corner:
// ddagrab captures the whole output at native resolution.
function start(
  { folder, audioDevice, displayIndex = 0, crop, label, fps = 30 },
  cb
) {
  if (session) return cb(new Error('already recording'));
  if (!crop || !crop.w || !crop.h) return cb(new Error('no capture region'));

  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    return cb(new Error(`cannot write to ${folder}: ${err.message}`));
  }

  const finalFile = path.join(folder, timestampName());
  const s = {
    opts: { folder, audioDevice, displayIndex, crop, label, fps },
    base: finalFile.replace(/\.mp4$/, ''),
    finalFile,
    segments: [],
    current: null,
    paused: false,
    busy: true,
    stopping: false,
  };
  session = s;
  syncLog = [];

  startSegment(s, (err) => {
    s.busy = false;
    if (err) {
      if (session === s) session = null;
      return cb(err);
    }
    cb(null, { file: finalFile, label, crop });
  });
}

// Pause: finish the running segment. Capture genuinely stops.
function pause(cb) {
  const s = session;
  if (!s || s.stopping || s.paused || s.busy || !s.current) return cb(new Error('cannot pause now'));
  s.busy = true;
  finishSegment(s, () => {
    s.paused = true;
    s.busy = false;
    cb(null);
  });
}

// Resume: start the next segment. Takes about a second -- the GPU encoder
// has to initialise again -- and the callback fires once capture is live.
function resume(cb) {
  const s = session;
  if (!s || s.stopping || !s.paused || s.busy) return cb(new Error('cannot resume now'));
  s.busy = true;
  startSegment(s, (err) => {
    s.busy = false;
    if (!err) s.paused = false;
    cb(err || null);
  });
}

function stop(cb) {
  const s = session;
  if (!s || s.stopping) return cb(null, null);
  s.stopping = true;

  // A pause or resume may be mid-flight; let it land first.
  const waitIdle = (then) => {
    const started = Date.now();
    const tick = () => {
      if (!s.busy || Date.now() - started > 15000) return then();
      setTimeout(tick, 100);
    };
    tick();
  };

  waitIdle(() => {
    finishSegment(s, () => {
      if (session === s) session = null;
      if (!s.segments.length) return cb(null, null);

      resolveFfmpeg((bin) => {
        const videos = s.segments.map((x) => x.file);
        joinFiles(bin, videos, s.finalFile, ['-movflags', '+faststart'], (ok) => {
          cb(null, ok ? s.finalFile : videos[0]);
        });
      });
    });
  });
}

function getLastSync() {
  return syncLog;
}

module.exports = {
  PRESETS,
  start,
  stop,
  pause,
  resume,
  isRecording,
  isPaused,
  listAudioDevices,
  probeAudioDevice,
  getLastSync,
};
