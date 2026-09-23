// Generates assets/icon.ico (and a 256px PNG) from assets/logo.svg.
//
// Nothing on this machine rasterizes SVG -- ffmpeg lacks librsvg, and neither
// ImageMagick nor Inkscape is installed. Electron already ships Chromium, so
// we render offscreen here instead of adding a dependency.
//
//   npm run icon              -> transparent background, logo as authored
//   npm run icon -- tile      -> logo on a dark rounded tile
//
// One offscreen window only: creating a second one reliably fails here with
// ERR_FAILED (-2), whether the source is a data: URL or a real file. So we
// render once at the largest size and downscale for the rest.

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const OUT_DIR = path.join(__dirname, '..', 'assets');
const SRC_SVG = path.join(OUT_DIR, 'logo.svg');
const OUT_ICO = path.join(OUT_DIR, 'icon.ico');
const OUT_PNG = path.join(OUT_DIR, 'icon.png');

// Windows picks the best match per context (taskbar, alt-tab, file explorer).
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const MASTER = 256;

// The logo is authored with its own colours, so the only choice here is
// whether it sits on a tile or floats transparent.
const VARIANTS = {
  flat: { background: 'none', radius: 0, pad: 0 },
  tile: { background: '#17181c', radius: 200, pad: 90 },
};

const variant = VARIANTS[process.argv[2]] || VARIANTS.flat;

// Strip the XML prolog and outer <svg> wrapper so the artwork can be nested
// inside our own sized canvas while keeping its viewBox mapping.
function readArtwork() {
  const raw = fs.readFileSync(SRC_SVG, 'utf8');
  const open = raw.match(/<svg\b[^>]*>/i);
  if (!open) throw new Error('logo.svg has no <svg> element');

  const viewBox = (open[0].match(/viewBox="([^"]+)"/i) || [])[1] || '0 0 24 24';
  const inner = raw
    .slice(open.index + open[0].length, raw.lastIndexOf('</svg>'))
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  return { viewBox, inner };
}

const { viewBox, inner } = readArtwork();

// Pad the artwork inside the tile so it does not touch the rounded corners.
const [vx, vy, vw, vh] = viewBox.split(/[\s,]+/).map(Number);
const pad = variant.pad;
const canvas = 960;
const scale = (canvas - pad * 2) / Math.max(vw, vh);

const htmlAt = (px) => `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block}
</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${canvas} ${canvas}">
  ${
    variant.background === 'none'
      ? ''
      : `<rect x="0" y="0" width="${canvas}" height="${canvas}" rx="${variant.radius}" ry="${variant.radius}" fill="${variant.background}"/>`
  }
  <g transform="translate(${pad},${pad}) scale(${scale}) translate(${-vx},${-vy})">
    ${inner}
  </g>
</svg>`;

// One offscreen window, one load. Reloading or resizing it invalidates the
// GPU surface on this machine (UnknownVizError), and opening a second window
// fails with ERR_FAILED, so the master is rendered once.
async function renderMaster(scratchDir) {
  const file = path.join(scratchDir, 'icon.html');
  fs.writeFileSync(file, htmlAt(MASTER), 'utf8');

  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });

  try {
    await win.loadFile(file);
    await new Promise((r) => setTimeout(r, 250));

    const image = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: MASTER,
      height: MASTER,
    });

    if (image.isEmpty()) throw new Error('master capture came back empty');
    return image.toPNG();
  } finally {
    win.destroy();
  }
}

// nativeImage.resize() blends the transparent background into the artwork --
// at 48px the red body came out near-white. ffmpeg scales in straight alpha,
// which keeps the colour intact.
function scaleWithFfmpeg(srcPath, size, outPath) {
  const { execFileSync } = require('node:child_process');
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', srcPath,
      '-vf', `scale=${size}:${size}:flags=lanczos`,
      '-y', outPath,
    ],
    { timeout: 15000 }
  );
  return fs.readFileSync(outPath);
}

async function renderAll(scratchDir) {
  const masterPng = await renderMaster(scratchDir);
  const masterPath = path.join(scratchDir, 'master.png');
  fs.writeFileSync(masterPath, masterPng);

  return SIZES.map((size) => {
    const png =
      size === MASTER
        ? masterPng
        : scaleWithFfmpeg(masterPath, size, path.join(scratchDir, `s${size}.png`));
    if (!png || png.length === 0) throw new Error(`empty PNG at ${size}px`);
    console.log(`  ${size}x${size} -> ${png.length} bytes`);
    return { size, png };
  });
}

// Minimal ICO container: 6-byte header, then a 16-byte directory entry per
// image, then the PNG payloads. Vista+ reads PNG-compressed entries directly,
// so there's no BMP encoding to do.
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const directory = [];

  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...directory, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camicon-'));

  try {
    console.log(`rendering from ${path.basename(SRC_SVG)}`);
    const entries = await renderAll(scratchDir);

    fs.writeFileSync(OUT_ICO, buildIco(entries));

    // The 256px entry doubles as the standalone PNG.
    const largest = entries[entries.length - 1];
    fs.writeFileSync(OUT_PNG, largest.png);

    const check = nativeImage.createFromPath(OUT_ICO);
    const dims = check.getSize();
    console.log(`\nwrote ${OUT_ICO}`);
    console.log(`  ${fs.statSync(OUT_ICO).size} bytes, ${SIZES.length} sizes`);
    console.log(
      `  loads as: ${check.isEmpty() ? 'EMPTY (bad)' : `valid ${dims.width}x${dims.height}`}`
    );
    console.log(`wrote ${OUT_PNG}`);
  } catch (err) {
    console.error(`\nICON BUILD FAILED: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    app.quit();
  }
});
