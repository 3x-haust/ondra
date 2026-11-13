#!/usr/bin/env node
// SVG → PNG at exact pixel sizes, in headless Chrome (the same renderer as the browser).
//
//   node render.mjs <file.svg> <out-dir> [--sizes 16,32,64,128,256,512,1024] [--pad 0.06]
//                   [--bg '#ffffff'] [--mono '#111111'] [--wide] [--name mark] [--construction]
//
// Square sizes contain the art centred with --pad (fraction of the side) on every side.
// --wide: sizes are widths and the height follows the art's aspect (wordmarks, lockups).
// --mono: every inked pixel in one colour (the silhouette). --bg: opaque background.
// Writes <out-dir>/<name>-<size>.png and prints each path.
import fs from 'node:fs';
import path from 'node:path';
import { launch, libPage, dataUrlToBuffer } from './lib/chrome.mjs';
import { parseArgs } from './lib/args.mjs';

const a = parseArgs(process.argv.slice(2), ['wide', 'construction']);
const [file, outDir] = a._;
if (!file || !outDir) { console.error('usage: node render.mjs <file.svg> <out-dir> [--sizes 16,32,...] [--pad 0.06] [--bg #fff] [--mono #000] [--wide] [--name base] [--construction]'); process.exit(2); }
const sizes = (a.sizes ?? '16,32,64,128,256,512,1024').split(',').map(Number);
const name = a.name ?? path.basename(file, '.svg');
const opts = { pad: Number(a.pad ?? 0), bg: a.bg ?? null, mono: a.mono ?? null, construction: !!a.construction };
const svg = fs.readFileSync(file, 'utf8');
fs.mkdirSync(outDir, { recursive: true });

const browser = await launch();
try {
  const page = await libPage(browser);
  const aspect = await page.eval(`(() => { const [, , w, h] = LOGO.prepare(${JSON.stringify(svg)}).viewBox; return w / h; })()`);
  for (const s of sizes) {
    const [w, h] = a.wide ? [s, Math.max(1, Math.round(s / aspect))] : [s, s];
    const url = await page.eval(`LOGO.raster(${JSON.stringify(svg)}, ${w}, ${h}, ${JSON.stringify(opts)}).then(LOGO.png)`);
    const out = path.join(outDir, `${name}-${s}.png`);
    fs.writeFileSync(out, dataUrlToBuffer(url));
    console.log(out);
  }
} finally { await browser.close(); }
