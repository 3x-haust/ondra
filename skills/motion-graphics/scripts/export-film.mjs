// Render a film page to MP4 with real motion blur.
// Each worker renders a contiguous run of frames, SUB sub-frames apiece, and pipes PNGs to its own ffmpeg, which
// averages each frame's sub-frames (tmix + select) into a near-lossless segment. Segments are joined and the
// sound is muxed in a final x264 pass (BT.709, faststart).
// Hard cuts listed in window.__film.CUTS (seconds) keep every sub-frame on its own frame's side of the cut, so a
// cut never double-exposes the two shots.
//
// usage: node export-film.mjs <film.html> <out.mp4> [--dur 30] [--ar h|v|s] [--fps 30] [--sub 10] [--workers 5]
//                             [--start 0] [--wav sound.wav]
//   --dur     seconds to render (default: the page's __film.D minus --start)
//   --start   render a clip from this time (check fast parts before a full render)
//   --sub     sub-frames per frame (1 = no blur; 8–10 for fast camera moves)
// The page must expose window.__film = { D, render(t), exportMode(ar) } (see film.html).
// Needs playwright (resolved from the current project, or `npm i playwright` in a scratch folder) and ffmpeg.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const pos = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const [html, out] = pos;
if (!html || !out) { console.error('usage: node export-film.mjs <film.html> <out.mp4> [--dur s] [--ar h|v|s] [--sub n] [--workers n] [--start s] [--wav file]'); process.exit(2); }

const req = createRequire(path.join(process.cwd(), 'noop.js'));
let chromium;
try { ({ chromium } = req('playwright')); } catch { ({ chromium } = await import('playwright')); }

const AR = { h: [1920, 1080], v: [1080, 1920], s: [1080, 1080] };
const ar = opt('ar', 'h'), [W, H] = AR[ar];
const FPS = +opt('fps', 30), SUB = Math.max(1, +opt('sub', 10)), WORKERS = Math.max(1, +opt('workers', 5)), START = +opt('start', 0);
const wav = opt('wav');
const url = 'file://' + path.resolve(html);

async function open() {
  // deterministic rendering: no threaded animation, every compositor stage before a capture, sRGB, no hinting
  const b = await chromium.launch({ args: ['--deterministic-mode', '--run-all-compositor-stages-before-draw', '--disable-threaded-animation',
    '--disable-threaded-scrolling', '--font-render-hinting=none', '--force-color-profile=srgb', '--hide-scrollbars'] });
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(url); await p.evaluate(() => document.fonts.ready);
  if (!(await p.evaluate(() => !!window.__film))) throw new Error('page has no window.__film');
  await p.evaluate(a => window.__film.exportMode(a), ar); await p.waitForTimeout(300);
  return { b, p, errors };
}

const probe = await open();
const D = await probe.p.evaluate(() => window.__film.D);
const CUTS = (await probe.p.evaluate(() => window.__film.CUTS || [])).slice().sort((x, y) => x - y); await probe.b.close();
// the last cut at or before time x (or -Infinity)
const cutBefore = x => { let c = -Infinity; for (const k of CUTS) if (k <= x + 1e-9) c = k; return c; };
const DUR = +opt('dur', (D - START).toFixed(3));
const NF = Math.round(DUR * FPS), per = Math.ceil(NF / WORKERS);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'film-'));
const run = (cmd, args) => new Promise((res, rej) => { const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] }); p.on('close', c => c ? rej(new Error(`${cmd} exited ${c}`)) : res()); });

async function worker(w) {
  const f0 = w * per, f1 = Math.min(NF, f0 + per); if (f0 >= f1) return null;
  const seg = path.join(tmp, `seg${w}.mkv`);
  const vf = SUB > 1 ? `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/${FPS}/TB` : 'setpts=N/' + FPS + '/TB';
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS * SUB), '-c:v', 'png', '-i', '-',
    '-vf', vf, '-r', String(FPS), '-c:v', 'libx264', '-crf', '6', '-preset', 'fast', '-pix_fmt', 'yuv444p', seg], { stdio: ['pipe', 'inherit', 'inherit'] });
  const { b, p, errors } = await open();
  for (let f = f0; f < f1; f++) for (let i = 0; i < SUB; i++) {
    // sub-frames sit inside the frame's interval and end on the frame's own time
    const tf = START + f / FPS;
    let t = START + (f * SUB + i - (SUB - 1)) / (FPS * SUB);
    t = Math.max(t, cutBefore(tf), 0);
    await p.evaluate(x => window.__film.render(x), t);
    const buf = await p.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r)); await b.close();
  if (errors.length) console.error(`worker ${w} page errors:`, [...new Set(errors)].slice(0, 5));
  return seg;
}

const t0 = Date.now();
console.log(`rendering ${DUR}s from ${START}s · ${W}×${H} · ${FPS} fps × ${SUB} sub · ${WORKERS} workers`);
const segs = (await Promise.all([...Array(WORKERS)].map((_, w) => worker(w)))).filter(Boolean);
const list = path.join(tmp, 'list.txt'); fs.writeFileSync(list, segs.map(s => `file '${s}'`).join('\n'));
const audio = wav && fs.existsSync(wav) ? ['-ss', String(START), '-i', wav] : [];
await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, ...audio,
  '-map', '0:v', ...(audio.length ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '15', '-preset', 'slow',
  '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', out]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('done', out, ((Date.now() - t0) / 60000).toFixed(1) + ' min');
