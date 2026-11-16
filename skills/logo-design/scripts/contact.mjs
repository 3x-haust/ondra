#!/usr/bin/env node
// Contact sheet for exploring many SVG sketches at once: each one big, at 32 and 16px,
// the real 16px pixels zoomed, and white on dark — so weak ideas drop out early.
//
//   node contact.mjs <dir | file.svg ...> <out.png> [--cols 4] [--big 160]
//
// A dir is searched for *.svg and <id>/mark.svg. Writes out.png (and out.html next to it).
import fs from 'node:fs';
import path from 'node:path';
import { launch, libPage } from './lib/chrome.mjs';
import { parseArgs } from './lib/args.mjs';

const a = parseArgs(process.argv.slice(2));
const out = a._.pop();
if (!a._.length || !out?.endsWith('.png')) { console.error('usage: node contact.mjs <dir | file.svg ...> <out.png> [--cols 4] [--big 160]'); process.exit(2); }
const files = [];
for (const p of a._) {
  if (fs.statSync(p).isFile()) { files.push(p); continue; }
  for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    if (e.isFile() && e.name.endsWith('.svg')) files.push(path.join(p, e.name));
    else if (e.isDirectory() && fs.existsSync(path.join(p, e.name, 'mark.svg'))) files.push(path.join(p, e.name, 'mark.svg'));
  }
}
if (!files.length) { console.error('no SVGs found'); process.exit(2); }
const cols = Number(a.cols ?? 4), big = Number(a.big ?? 160);
const label = (f) => (path.basename(f) === 'mark.svg' ? path.basename(path.dirname(f)) : path.basename(f, '.svg'));
const data = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const browser = await launch();
try {
  const page = await libPage(browser);
  const cells = [];
  for (const f of files) {
    const svg = await page.eval(`LOGO.clean(${JSON.stringify(fs.readFileSync(f, 'utf8'))})`);
    const px16 = await page.eval(`LOGO.raster(${JSON.stringify(svg)}, 16, 16, { pad: 0.06 }).then(LOGO.png)`);
    cells.push(`<div class="c"><div class="l"><img src="${data(svg)}" style="width:${big}px;height:${big}px"><div class="s"><img src="${data(svg)}" style="width:32px;height:32px"><img src="${data(svg)}" style="width:16px;height:16px"><img class="z" src="${px16}"></div></div>
<div class="d"><img class="w" src="${data(svg)}" style="width:${big / 2}px;height:${big / 2}px"><img class="w" src="${data(svg)}" style="width:16px;height:16px"></div><p>${label(f).replace(/[<&]/g, '')}</p></div>`);
  }
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff;font:12px -apple-system,system-ui,sans-serif;color:#333}
.g{display:grid;grid-template-columns:repeat(${cols},${big + 120}px);gap:14px;padding:18px}.c{border:1px solid #e5e3de;border-radius:12px;overflow:hidden}
.l{background:#f6f5f1;display:flex;gap:14px;align-items:center;padding:16px}.s{display:grid;gap:10px;justify-items:center}.z{width:64px;height:64px;image-rendering:pixelated}
.d{background:#141414;display:flex;gap:18px;align-items:center;padding:12px 16px}.w{filter:brightness(0) invert(1)}p{margin:0;padding:8px 12px}</style><div class="g">${cells.join('')}</div>`;
  const htmlFile = out.replace(/\.png$/, '.html');
  fs.writeFileSync(htmlFile, html);
  const p2 = await browser.page(cols * (big + 134) + 40, 600);
  await p2.load({ file: htmlFile });
  fs.writeFileSync(out, await p2.shot({ fullPage: true }));
  console.log(out);
} finally { await browser.close(); }
