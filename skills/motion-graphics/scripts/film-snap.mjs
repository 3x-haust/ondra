// Still frames of a film page, for the stills board and for review.
// usage: node film-snap.mjs <film.html> <out-dir> [h|v|s] [t1,t2,...]
//        node film-snap.mjs <film.html> <out-dir> [h|v|s] --cuts      a strip across every cut in __film.CUTS
//                                                                     (-0.2 s, the last frame before, the cut, +0.2 s)
// Without times: one still every second (at .5). Also writes board.jpg (all stills tiled) when ffmpeg is present.
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process'; import { createRequire } from 'node:module';
const args = process.argv.slice(2);
const cutsMode = args.includes('--cuts');
const [html, outDir, ar = 'h', times] = args.filter(a => a !== '--cuts');
if (!html || !outDir) { console.error('usage: node film-snap.mjs <film.html> <out-dir> [h|v|s] [t1,t2,...|--cuts]'); process.exit(2); }
const req = createRequire(path.join(process.cwd(), 'noop.js'));
let chromium;
try { ({ chromium } = req('playwright')); } catch { ({ chromium } = await import('playwright')); }
const [W, H] = { h: [1920, 1080], v: [1080, 1920], s: [1080, 1080] }[ar];
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ args: ['--deterministic-mode', '--run-all-compositor-stages-before-draw', '--disable-threaded-animation', '--font-render-hinting=none', '--force-color-profile=srgb'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', e => console.log('PAGE ERROR', e.message));
await p.goto('file://' + path.resolve(html)); await p.evaluate(() => document.fonts.ready);
await p.evaluate(a => window.__film.exportMode(a), ar);
const { D, CUTS = [] } = await p.evaluate(() => ({ D: window.__film.D, CUTS: window.__film.CUTS }));
let ts;
if (cutsMode) {
  if (!CUTS.length) console.log('no __film.CUTS on the page');
  ts = CUTS.flatMap(c => [c - 0.2, c - 1 / 30, c, c + 0.2]).filter(t => t >= 0 && t < D);
} else ts = times ? times.split(',').map(Number) : Array.from({ length: Math.ceil(D) }, (_, i) => i + 0.5).filter(t => t < D);
const files = [];
for (const t of ts) {
  await p.evaluate(x => window.__film.render(x), t);
  const f = path.join(outDir, `${ar}-${t.toFixed(3).padStart(7, '0')}.png`);
  await p.screenshot({ path: f }); files.push(f); console.log(f);
}
await b.close();
if (files.length > 1 && !spawnSync('ffmpeg', ['-version']).error) {
  const cols = cutsMode ? 4 : Math.min(6, files.length), rows = Math.ceil(files.length / cols);
  const list = path.join(outDir, '_board.txt');
  fs.writeFileSync(list, files.map(f => `file '${path.resolve(f)}'\nduration 1`).join('\n'));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=480:-2,tile=${cols}x${rows}:padding=6:margin=6`, '-frames:v', '1', '-q:v', '3', path.join(outDir, 'board.jpg')], { stdio: 'inherit' });
  fs.rmSync(list);
  if (!r.status) console.log(path.join(outDir, 'board.jpg'), `(${cols}×${rows}, in time order)`);
}
