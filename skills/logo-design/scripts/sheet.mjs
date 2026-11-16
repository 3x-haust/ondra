#!/usr/bin/env node
// Comparison sheet for logo concepts: one self-contained HTML page the user picks from,
// plus a PNG of it. Every concept is shown the same way — big on light and dark, one
// colour, real 16/32/64/128px renders (and 16px zoomed so the pixels show), in a browser
// tab, as an app icon, in a header, as an avatar, its construction and outline views —
// with the measured checks from measure.mjs next to it.
//
//   node sheet.mjs <concepts-dir> <out-dir> [--name "Brand"] [--refs <dir>] [--title "…"]
//
// <concepts-dir>/<id>/mark.svg            the mark (required; may hold <g id="construction">)
//                    /wordmark.svg        lettering, optional (else --name is set in system type)
//                    /mark-dark.svg       a drawn version for dark backgrounds, optional
//                    /concept.json        {"title", "idea", "tile": "#hex", "ink": "#hex"}, optional
// Writes <out-dir>/compare.html, compare.png, cards/<id>.png and measure.json.
import fs from 'node:fs';
import path from 'node:path';
import { launch, libPage, dataUrlToBuffer } from './lib/chrome.mjs';
import { parseArgs } from './lib/args.mjs';
import { findMarks, measureAll, refsOf } from './measure.mjs';

const a = parseArgs(process.argv.slice(2));
const [dir, outDir] = a._;
if (!dir || !outDir) { console.error('usage: node sheet.mjs <concepts-dir> <out-dir> [--name Brand] [--refs dir] [--title "..."]'); process.exit(2); }
fs.mkdirSync(path.join(outDir, 'cards'), { recursive: true });
const brand = a.name ?? 'Brand';
const marks = findMarks([dir]);
if (!marks.length) { console.error(`no <id>/mark.svg under ${dir}`); process.exit(2); }

const results = await measureAll(marks, { refs: refsOf(a.refs) });
fs.writeFileSync(path.join(outDir, 'measure.json'), JSON.stringify(results, null, 1));

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const svgData = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const browser = await launch();
let html;
try {
  const page = await libPage(browser);
  const cards = [];
  for (const [i, mk] of marks.entries()) {
    const cdir = mk.dir ?? path.dirname(mk.file);
    const raw = fs.readFileSync(mk.file, 'utf8');
    const svg = await page.eval(`LOGO.clean(${JSON.stringify(raw)})`); // shown without its construction layer
    const meta = mk.dir ? JSON.parse(read(path.join(cdir, 'concept.json')) ?? '{}') : {};
    const word = mk.dir ? read(path.join(cdir, 'wordmark.svg')) : null;
    const darkRaw = mk.dir ? read(path.join(cdir, 'mark-dark.svg')) : null;
    const dark = darkRaw ? await page.eval(`LOGO.clean(${JSON.stringify(darkRaw)})`) : null;
    const px = {};
    for (const n of [16, 32]) px[n] = await page.eval(`LOGO.raster(${JSON.stringify(svg)}, ${n}, ${n}, { pad: 0.06 }).then(LOGO.png)`);
    const outline = await page.eval(`LOGO.view(${JSON.stringify(raw)}, 260, { mode: 'outline' })`);
    const lint = results[i].metrics.lint ?? {};
    const construction = lint.construction ? await page.eval(`LOGO.view(${JSON.stringify(raw)}, 260, { mode: 'construction' })`) : null;
    cards.push({ id: mk.name, letter: String.fromCharCode(65 + i), svg, word, dark, meta, px, outline, construction, result: results[i] });
  }
  html = sheetHtml(cards);
  const file = path.join(outDir, 'compare.html');
  fs.writeFileSync(file, html);
  console.log(file);
  const shotPage = await browser.page(1440, 900);
  await shotPage.load({ file });
  fs.writeFileSync(path.join(outDir, 'compare.png'), await shotPage.shot({ fullPage: true }));
  console.log(path.join(outDir, 'compare.png'));
  const rects = await shotPage.eval(`[...document.querySelectorAll('.card')].map(e => { const r = e.getBoundingClientRect(); return { id: e.dataset.id, x: r.x, y: r.y + scrollY, width: r.width, height: r.height }; })`);
  for (const r of rects) {
    const out = path.join(outDir, 'cards', `${r.id}.png`);
    fs.writeFileSync(out, await shotPage.shot({ clip: { x: r.x, y: r.y, width: r.width, height: r.height } }));
    console.log(out);
  }
} finally { await browser.close(); }

for (const r of results) {
  const worst = r.checks.find((c) => c.level === 'fail') ?? r.checks.find((c) => c.level === 'warn');
  console.log(`${r.name}: ${r.checks.filter((c) => c.level === 'pass').length}/${r.checks.length} pass${worst ? ` · ${worst.level} ${worst.check}: ${worst.note}` : ''}`);
}

function sheetHtml(cards) {
  const chip = (c) => `<li class="chk ${c.level}"><b>${esc(c.check)}</b><span>${esc(c.note)}</span></li>`;
  const summary = cards.map((c) => `<tr><th><span class="letter">${c.letter}</span> ${esc(c.meta.title ?? c.id)}</th>${c.result.checks.map((k) => `<td class="${k.level}" title="${esc(k.note)}">${esc(k.check)}</td>`).join('')}</tr>`).join('');
  const body = cards.map((c) => {
    const mark = svgData(c.svg);
    const darkSrc = c.dark ? svgData(c.dark) : mark;
    const darkCls = c.dark ? '' : 'white';
    const tile = c.meta.tile ?? '#18181b';
    const word = c.word ? `<img class="word" src="${svgData(c.word)}" alt="">` : `<span class="wordtext">${esc(brand)}</span>`;
    const wordDark = c.word ? `<img class="word white" src="${svgData(c.word)}" alt="">` : `<span class="wordtext">${esc(brand)}</span>`;
    return `<section class="card" data-id="${esc(c.id)}">
  <header><span class="letter">${c.letter}</span><div><h2>${esc(c.meta.title ?? c.id)}</h2><p>${esc(c.meta.idea ?? '')}</p></div></header>
  <div class="hero">
    <figure class="paper"><img src="${mark}" alt=""><figcaption>light</figcaption></figure>
    <figure class="ink"><img class="${darkCls}" src="${darkSrc}" alt=""><figcaption>dark${c.dark ? '' : ' · silhouette'}</figcaption></figure>
    <figure class="paper"><img class="black" src="${mark}" alt=""><figcaption>one colour</figcaption></figure>
    <figure style="background:${esc(tile)}"><img class="white" src="${mark}" alt=""><figcaption style="color:#fff9">reversed</figcaption></figure>
  </div>
  <div class="row">
    <div class="sizes paper">${[128, 64, 32, 16].map((n) => `<img src="${mark}" style="width:${n}px;height:${n}px" alt="">`).join('')}<span class="cap">128 · 64 · 32 · 16 px</span></div>
    <div class="sizes ink">${[64, 32, 16].map((n) => `<img class="${darkCls}" src="${darkSrc}" style="width:${n}px;height:${n}px" alt="">`).join('')}<span class="cap">dark</span></div>
    <div class="zoom paper"><img src="${c.px[16]}" alt=""><span class="cap">real 16px ×8</span></div>
    <div class="zoom paper"><img src="${c.px[32]}" class="z32" alt=""><span class="cap">real 32px ×4</span></div>
  </div>
  <div class="row">
    <div class="tab"><div class="tabbar"><span class="t on"><img src="${c.px[32]}" alt="">${esc(brand)}</span><span class="t">New Tab</span></div><div class="tabbody"></div></div>
    <div class="tab darkt"><div class="tabbar"><span class="t on"><img class="${darkCls}" src="${darkSrc}" alt="">${esc(brand)}</span><span class="t">New Tab</span></div><div class="tabbody"></div></div>
    <div class="app"><div class="icon" style="background:${esc(tile)}"><img class="white" src="${mark}" alt=""></div><span>${esc(brand)}</span></div>
    <div class="avatar"><div class="av" style="background:${esc(tile)}"><img class="white" src="${mark}" alt=""></div><div class="av paperbg"><img src="${mark}" alt=""></div></div>
  </div>
  <div class="row">
    <div class="header light"><img class="m" src="${mark}" alt="">${word}<nav><i></i><i></i><i></i></nav></div>
    <div class="header dark"><img class="m ${darkCls}" src="${darkSrc}" alt="">${wordDark}<nav><i></i><i></i><i></i></nav></div>
  </div>
  <div class="row views">
    ${c.construction ? `<figure class="view"><img src="${svgData(c.construction)}" alt=""><figcaption>construction</figcaption></figure>` : ''}
    <figure class="view"><img src="${svgData(c.outline)}" alt=""><figcaption>outline · points and handles</figcaption></figure>
    <ul class="checks">${c.result.checks.map(chip).join('')}</ul>
  </div>
</section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title ?? `${brand} — logo concepts`)}</title>
<style>
:root{--paper:#f6f5f1;--ink:#141414;--line:#e4e2dc;--muted:#77756f;--pass:#1f7a4d;--warn:#a96800;--fail:#c0262d}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo",sans-serif}
main{max-width:1320px;margin:0 auto;padding:40px 32px 64px}
h1{font-size:26px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}.sub{color:var(--muted);margin:0 0 24px}
table{border-collapse:collapse;margin:0 0 36px;font-size:12px}th{text-align:left;font-weight:600;padding:6px 14px 6px 0;white-space:nowrap}
td{padding:4px 8px;border:2px solid #fff;border-radius:6px;white-space:nowrap}td.pass{background:#e6f3ec;color:var(--pass)}td.warn{background:#fbf0dc;color:var(--warn)}td.fail{background:#fbe3e3;color:var(--fail)}
.card{border:1px solid var(--line);border-radius:18px;padding:24px;margin:0 0 32px;break-inside:avoid}
.card header{display:flex;gap:14px;align-items:flex-start;margin-bottom:18px}.card h2{margin:0;font-size:19px;font-weight:600}.card header p{margin:2px 0 0;color:var(--muted);max-width:820px}
.letter{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--ink);color:#fff;font-weight:700;font-size:14px;flex:none}
th .letter{width:22px;height:22px;font-size:11px;margin-right:6px}
.hero{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
figure{margin:0;border-radius:12px;position:relative;display:grid;place-items:center;aspect-ratio:1/1}figure img{width:58%;height:58%;object-fit:contain}
figcaption,.cap{position:absolute;left:12px;bottom:8px;font-size:11px;color:var(--muted)}
.paper{background:var(--paper)}.ink{background:var(--ink)}.ink figcaption,.ink .cap{color:#aaa}
img.white{filter:brightness(0) invert(1)}img.black{filter:brightness(0)}
.row{display:flex;gap:12px;margin-top:12px;align-items:stretch;flex-wrap:wrap}
.sizes{flex:1 1 300px;border-radius:12px;display:flex;gap:22px;align-items:center;padding:24px 22px 32px;position:relative;min-height:150px}.sizes img{object-fit:contain}
.zoom{width:170px;border-radius:12px;display:grid;place-items:center;padding:12px 12px 26px;position:relative}.zoom img{width:128px;height:128px;image-rendering:pixelated}
.tab{flex:1 1 260px;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:#fff}.tabbar{display:flex;gap:2px;background:#dfe1e5;padding:8px 8px 0}
.t{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;border-radius:8px 8px 0 0;color:#444;min-width:120px}.t.on{background:#fff}.t img{width:16px;height:16px}
.tabbody{height:58px;background:#fff}.darkt{background:#202124;border-color:#202124}.darkt .tabbar{background:#000}.darkt .t{color:#bbb}.darkt .t.on{background:#35363a;color:#eee}.darkt .tabbody{background:#35363a}
.app{width:150px;display:grid;justify-items:center;align-content:center;gap:8px;background:linear-gradient(160deg,#c9d6e8,#e9d9cf);border-radius:12px;padding:18px 0}
.app .icon{width:76px;height:76px;border-radius:18px;display:grid;place-items:center;box-shadow:0 1px 3px #0003}.app .icon img{width:62%;height:62%;object-fit:contain}.app span{font-size:11px;color:#222}
.avatar{display:flex;gap:12px;align-items:center;padding:0 12px;background:var(--paper);border-radius:12px}.av{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;overflow:hidden}.av img{width:60%;height:60%;object-fit:contain}.paperbg{background:#fff;border:1px solid var(--line)}
.header{flex:1 1 420px;display:flex;align-items:center;gap:10px;height:64px;padding:0 22px;border-radius:12px}.header.light{background:#fff;border:1px solid var(--line)}.header.dark{background:var(--ink)}
.header .m{height:28px;width:28px;object-fit:contain}.header .word{height:18px;width:auto}.wordtext{font-weight:650;font-size:18px;letter-spacing:-.01em}.dark .wordtext{color:#fff}
.header nav{margin-left:auto;display:flex;gap:14px}.header nav i{display:block;width:44px;height:7px;border-radius:4px;background:#0001}.dark nav i{background:#fff2}
.views figure.view{width:270px;aspect-ratio:auto;padding:6px;background:#fff;border:1px solid var(--line)}.view img{display:block;width:256px;height:256px}.view figcaption{position:static;padding:4px 6px 2px}
.checks{list-style:none;margin:0;padding:0;flex:1 1 360px;display:grid;gap:5px;align-content:start;font-size:12px}
.chk{display:grid;grid-template-columns:96px 1fr;gap:10px;padding:6px 10px;border-radius:8px}.chk b{font-weight:600}.chk.pass{background:#f0f7f3}.chk.pass b{color:var(--pass)}.chk.warn{background:#fdf5e8}.chk.warn b{color:var(--warn)}.chk.fail{background:#fdeeee}.chk.fail b{color:var(--fail)}
@media (max-width:700px){main{padding:20px 16px}.hero{grid-template-columns:repeat(2,1fr)}}
</style></head><body><main>
<h1>${esc(a.title ?? `${brand} — logo concepts`)}</h1>
<p class="sub">${cards.length} concepts, each shown the same way. Checks are measured on the real renders.</p>
<table>${summary}</table>
${body}
</main></body></html>`;
}
