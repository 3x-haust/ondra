#!/usr/bin/env node
// Brand kit from the approved mark: vector variants, lockups, PNGs, favicon set (ICO, SVG,
// apple-touch, PWA icons, manifest, <head> snippet), OG image, avatar, palette tokens with
// measured contrast, and a one-page usage guide (HTML, PDF, PNG).
//
//   node kit.mjs <final-dir> <out-dir>
//
// <final-dir>/mark.svg        required; the approved mark (a #construction layer is removed)
//            /wordmark.svg    lettering as outlines (recommended)
//            /mark-dark.svg   drawn version for dark backgrounds (else the mark in white)
//            /mark-small.svg  simplified mark for 16–32px (else the mark)
//            /brand.json      see references/kit.md (name, colors, fonts, lockup, favicon, og…)
import fs from 'node:fs';
import path from 'node:path';
import { launch, libPage, dataUrlToBuffer } from './lib/chrome.mjs';
import { parseArgs } from './lib/args.mjs';
import { measureAll } from './measure.mjs';

const a = parseArgs(process.argv.slice(2));
const [src, out] = a._;
if (!src || !out) { console.error('usage: node kit.mjs <final-dir> <out-dir>'); process.exit(2); }
const read = (f) => (fs.existsSync(path.join(src, f)) ? fs.readFileSync(path.join(src, f), 'utf8') : null);
const B = JSON.parse(read('brand.json') ?? '{}');
const name = B.name ?? 'Brand';
const colors = B.colors ?? [{ name: 'Ink', hex: '#141414', role: 'primary' }, { name: 'Paper', hex: '#ffffff', role: 'background' }];
const ink = B.ink ?? colors[0].hex;
const paper = B.paper ?? colors.find((c) => /background|paper/i.test(c.role ?? ''))?.hex ?? '#ffffff';
const night = B.night ?? '#111111';
const lock = { markScale: 1.5, gap: 0.45, stackScale: 2.4, stackGap: 0.55, ...(B.lockup ?? {}) };
const fav = { style: 'tile', bg: ink, fg: paper, radius: 0.22, inset: 0.18, ...(B.favicon ?? {}) };
const clear = B.clearSpace ?? 0.25;
const minSize = { mark: 16, lockup: 72, ...(B.minSize ?? {}) };
const files = [];
const dirs = ['svg', 'png', 'favicon', 'social', 'palette'];
for (const d of dirs) fs.mkdirSync(path.join(out, d), { recursive: true });
const write = (rel, data) => { const f = path.join(out, rel); fs.writeFileSync(f, data); files.push(rel); return f; };

const markSrc = read('mark.svg');
if (!markSrc) { console.error(`${src}/mark.svg is missing`); process.exit(2); }
const wordSrc = read('wordmark.svg');
const darkSrc = read('mark-dark.svg');
const smallSrc = read('mark-small.svg');

/** ICO with PNG payloads (Vista+ and every browser read these). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i; head.writeUInt8(size >= 256 ? 0 : size, o); head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(data.length, o + 8); head.writeUInt32LE(off, o + 12); off += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

const fontFace = (role) => {
  const f = B.fonts?.[role]; if (!f) return '';
  const file = f.file && path.join(src, f.file);
  if (!file || !fs.existsSync(file)) return '';
  const fmt = file.endsWith('.woff2') ? 'woff2' : file.endsWith('.woff') ? 'woff' : file.endsWith('.otf') ? 'opentype' : 'truetype';
  return `@font-face{font-family:"${f.family}";src:url(data:font/${fmt};base64,${fs.readFileSync(file).toString('base64')}) format("${fmt}");font-weight:100 900;font-display:block}`;
};
const fam = (role, fallback) => (B.fonts?.[role]?.family ? `'${B.fonts[role].family}', ${fallback}` : fallback); // single quotes: also used inside style="…"
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dataSvg = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const browser = await launch();
try {
  const page = await libPage(browser);
  const J = JSON.stringify;
  const ev = (expr) => page.eval(expr);
  const png = async (svg, w, h, opts = {}) => dataUrlToBuffer(await ev(`LOGO.raster(${J(svg)}, ${w}, ${h}, ${J(opts)}).then(LOGO.png)`));

  // ── vectors ──
  const mark = (await ev(`LOGO.crop(${J(markSrc)})`));
  const markClean = await ev(`LOGO.clean(${J(markSrc)})`);
  write('svg/mark.svg', markClean);
  write('svg/mark-cropped.svg', mark.svg);
  const markBlack = await ev(`LOGO.recolor(${J(mark.svg)}, '#000000')`);
  const markWhite = await ev(`LOGO.recolor(${J(mark.svg)}, '#ffffff')`);
  const markInk = await ev(`LOGO.recolor(${J(mark.svg)}, ${J(ink)})`);
  write('svg/mark-black.svg', markBlack); write('svg/mark-white.svg', markWhite);
  const markDark = darkSrc ? (await ev(`LOGO.crop(${J(darkSrc)})`)).svg : markWhite;
  if (darkSrc) write('svg/mark-dark.svg', markDark);
  let word = null, wordWhite = null, wordDark = null;
  if (wordSrc) {
    word = await ev(`LOGO.crop(${J(wordSrc)})`);
    write('svg/wordmark.svg', word.svg);
    write('svg/wordmark-black.svg', await ev(`LOGO.recolor(${J(word.svg)}, '#000000')`));
    wordWhite = await ev(`LOGO.recolor(${J(word.svg)}, '#ffffff')`);
    write('svg/wordmark-white.svg', wordWhite);
    wordDark = wordWhite;
  }

  // ── lockups (units: wordmark ink height = 100) ──
  const lockups = {};
  if (word) {
    const U = 100, mh = lock.markScale * U, mw = mh * mark.w / mark.h, ww = U * word.w / word.h, gap = lock.gap * U;
    const H = Math.max(mh, U), W = mw + gap + ww;
    const horiz = (m, w) => ev(`LOGO.compose(${J([{ svg: m, x: 0, y: (H - mh) / 2, h: mh }, { svg: w, x: mw + gap, y: (H - U) / 2 + (lock.wordShift ?? 0) * U, h: U }])}, ${W}, ${H})`);
    const sh = lock.stackScale * U, sw = sh * mark.w / mark.h, sg = lock.stackGap * U, SW = Math.max(sw, ww), SH = sh + sg + U;
    const stack = (m, w) => ev(`LOGO.compose(${J([{ svg: m, x: (SW - sw) / 2, y: 0, h: sh }, { svg: w, x: (SW - ww) / 2, y: sh + sg, h: U }])}, ${SW}, ${SH})`);
    lockups.horizontal = await horiz(mark.svg, word.svg);
    lockups['horizontal-white'] = await horiz(markDark, wordDark);
    lockups.stacked = await stack(mark.svg, word.svg);
    lockups['stacked-white'] = await stack(markDark, wordDark);
    for (const [k, v] of Object.entries(lockups)) write(`svg/lockup-${k}.svg`, v);
  }

  // ── PNGs ──
  for (const s of [64, 128, 256, 512, 1024]) write(`png/mark-${s}.png`, await png(mark.svg, s, s));
  write('png/mark-white-512.png', await png(markDark, 512, 512));
  write('png/mark-black-512.png', await png(markBlack, 512, 512));
  if (word) {
    for (const w of [600, 1200]) write(`png/wordmark-${w}.png`, await png(word.svg, w, Math.round(w * word.h / word.w)));
    for (const [k, v] of Object.entries(lockups)) {
      const [, , vw, vh] = (await ev(`LOGO.prepare(${J(v)}).viewBox`));
      for (const w of [600, 1200]) write(`png/lockup-${k}-${w}.png`, await png(v, w, Math.round(w * vh / vw)));
    }
  }

  // ── favicon set ──
  const small = smallSrc ? (await ev(`LOGO.crop(${J(smallSrc)})`)).svg : mark.svg;
  // fav.art "dark": large icons keep the drawn dark version's colours on the tile; 16–48px stay one colour
  const big = fav.art === 'dark' ? markDark : mark.svg;
  const keep = fav.art === 'dark';
  const iconSvg = async (art, S, { inset = fav.inset, radius = fav.radius, opaque = false, colours = false } = {}) => {
    if (fav.style === 'bare' && !opaque) {
      const r = mark.w / mark.h; const w = r >= 1 ? S : S * r, h = r >= 1 ? S / r : S;
      return ev(`LOGO.compose(${J([{ svg: await ev(`LOGO.recolor(${J(art)}, ${J(fav.fg === paper ? ink : fav.fg)})`), x: (S - w) / 2, y: (S - h) / 2, w, h }])}, ${S}, ${S})`);
    }
    const fg = colours ? art : await ev(`LOGO.recolor(${J(art)}, ${J(fav.fg)})`);
    const box = S * (1 - 2 * inset), r = mark.w / mark.h; const w = r >= 1 ? box : box * r, h = r >= 1 ? box / r : box;
    return ev(`LOGO.compose(${J([{ rect: { x: 0, y: 0, width: S, height: S, rx: S * radius, fill: fav.bg } }, { svg: fg, x: (S - w) / 2, y: (S - h) / 2, w, h }])}, ${S}, ${S})`);
  };
  const favSmall = await iconSvg(small, 64);
  let favSvg = favSmall; // tabs show it at 16–32px: the small, one-colour drawing
  if (fav.style === 'bare') favSvg = favSvg.replace(/^(<svg[^>]*>)/, `$1<style>@media (prefers-color-scheme: dark){svg svg *{fill:${fav.darkFg ?? '#ffffff'}}}</style>`);
  write('favicon/favicon.svg', favSvg);
  const icoPngs = [];
  for (const s of [16, 32, 48]) { const d = await png(favSmall, s, s); icoPngs.push({ size: s, data: d }); if (s !== 48) write(`favicon/favicon-${s}.png`, d); }
  write('favicon/favicon.ico', ico(icoPngs));
  const opaqueTile = await iconSvg(big, 180, { radius: 0, inset: 0.2, opaque: true, colours: keep });
  write('favicon/apple-touch-icon.png', await png(opaqueTile, 180, 180));
  for (const s of [192, 512]) write(`favicon/icon-${s}.png`, await png(await iconSvg(big, s, { opaque: true, colours: keep }), s, s));
  write('favicon/icon-maskable-512.png', await png(await iconSvg(big, 512, { radius: 0, inset: 0.27, opaque: true, colours: keep }), 512, 512));
  write('favicon/site.webmanifest', JSON.stringify({ name, short_name: name, icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }], theme_color: fav.bg, background_color: paper, display: 'standalone' }, null, 2));
  write('favicon/head.html', `<link rel="icon" href="/favicon.ico" sizes="32x32">\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n<link rel="manifest" href="/site.webmanifest">\n<meta name="theme-color" content="${fav.bg}">\n<meta property="og:image" content="/og.png">\n`);

  // ── palette ──
  const contrast = await ev(`(${J(colors)}).map(c => ({ ...c, rgb: LOGO.rgb(c.hex), vsWhite: +LOGO.contrast(LOGO.rgb(c.hex), [255,255,255]).toFixed(2), vsBlack: +LOGO.contrast(LOGO.rgb(c.hex), [0,0,0]).toFixed(2), vs: Object.fromEntries((${J(colors)}).map(d => [d.name, +LOGO.contrast(LOGO.rgb(c.hex), LOGO.rgb(d.hex)).toFixed(2)])) }))`);
  write('palette/palette.json', JSON.stringify(contrast, null, 2));
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  write('palette/tokens.css', `:root {\n${colors.map((c) => `  --${slug(name)}-${slug(c.name)}: ${c.hex};${c.role ? ` /* ${c.role} */` : ''}`).join('\n')}\n}\n`);

  // ── social ──
  const og = { bg: B.og?.bg ?? ink, fg: B.og?.fg ?? paper, title: B.og?.title ?? B.tagline ?? '', subtitle: B.og?.subtitle ?? '' };
  const ogLock = word ? (og.bg === ink || isDark(og.bg) ? lockups['horizontal-white'] : lockups.horizontal) : (isDark(og.bg) ? markDark : mark.svg);
  const ogHtml = `<!doctype html><meta charset="utf-8"><style>${fontFace('display')}${fontFace('text')}
html,body{margin:0;width:1200px;height:630px;background:${og.bg};color:${og.fg};overflow:hidden}
.w{position:absolute;inset:0;padding:84px 96px;display:flex;flex-direction:column;justify-content:space-between}
.l{height:${word ? 78 : 150}px;align-self:flex-start}h1{font:600 60px/1.08 ${fam('display', 'system-ui, sans-serif')};letter-spacing:-.02em;margin:0;max-width:940px}
p{font:400 26px/1.4 ${fam('text', 'system-ui, sans-serif')};opacity:.72;margin:18px 0 0;max-width:900px}</style>
<div class="w"><img class="l" src="${dataSvg(ogLock)}"><div>${og.title ? `<h1>${esc(og.title)}</h1>` : ''}${og.subtitle ? `<p>${esc(og.subtitle)}</p>` : ''}</div></div>`;
  const ogPage = await browser.page(1200, 630);
  await ogPage.load({ html: ogHtml });
  write('social/og.png', await ogPage.shot());
  write('social/avatar-400.png', await png(await iconSvg(big, 400, { radius: 0, inset: 0.24, opaque: true, colours: keep }), 400, 400));

  // ── measured checks of what ships ──
  const shipped = [{ name: 'mark', file: path.join(out, 'svg', 'mark.svg') }];
  if (darkSrc) shipped.push({ name: 'mark-dark', file: path.join(out, 'svg', 'mark-dark.svg') });
  const measured = await measureAll(shipped, {});
  const checks = measured.flatMap((r) => r.checks.map((c) => ({ ...c, check: measured.length > 1 ? `${r.name} · ${c.check}` : c.check })));

  // ── guide ──
  const guide = guideHtml({ mark, markDark, word, wordWhite, lockups, contrast, checks, icoPngs });
  const gf = write('guide.html', guide);
  const gp = await browser.page(1240, 900);
  await gp.load({ file: gf });
  write('guide.png', await gp.shot({ fullPage: true }));
  write('guide.pdf', await gp.pdf({ paperWidth: 11.69, paperHeight: 8.27, marginTop: 0.3, marginBottom: 0.3, marginLeft: 0.3, marginRight: 0.3 }));
  write('README.txt', `${name} brand kit\n\n${files.concat('README.txt').map((f) => `  ${f}`).join('\n')}\n\nMade from ${path.resolve(src)} with kit.mjs.\n`);
  for (const f of files) console.log(path.join(out, f));
  for (const c of checks) console.log(`${c.level.toUpperCase()}  ${c.check}: ${c.note}`);
} finally { await browser.close(); }

function isDark(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

function guideHtml({ mark, markDark, word, wordWhite, lockups, contrast, checks, icoPngs }) {
  const main = word ? lockups.horizontal : mark.svg;
  const mainDark = word ? lockups['horizontal-white'] : markDark;
  const img = (svg, cls = '', style = '') => `<img class="${cls}" style="${style}" src="${dataSvg(svg)}" alt="">`;
  const fonts = Object.entries(B.fonts ?? {}).map(([role, f]) => `<div class="font"><div class="spec">${esc(role)} · ${esc(f.family)} ${esc(f.weight ?? '')}${f.licence ? ` · ${esc(f.licence)}` : ''}</div>
    <div style="font-family:${fam(role, 'system-ui')};font-weight:${f.weight ?? 400};font-size:${role === 'display' ? 44 : 20}px;line-height:1.2;letter-spacing:${role === 'display' ? '-.02em' : '0'}">${esc(f.sample ?? (role === 'display' ? (B.tagline ?? name) : 'The quick brown fox jumps over the lazy dog. 다람쥐 헌 쳇바퀴에 타고파 0123456789'))}</div></div>`).join('');
  const sw = contrast.map((c) => `<div class="sw"><div class="chip" style="background:${c.hex}"></div><b>${esc(c.name)}</b><span>${c.hex.toUpperCase()} · rgb ${c.rgb.join(' ')}</span><span>${esc(c.role ?? '')}</span>
    <span>on white ${c.vsWhite}:1 ${grade(c.vsWhite)} · on black ${c.vsBlack}:1 ${grade(c.vsBlack)}</span></div>`).join('');
  const matrix = `<table class="mx"><tr><th></th>${contrast.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr>${contrast.map((r) => `<tr><th>${esc(r.name)}</th>${contrast.map((c) => `<td style="background:${c.hex};color:${r.hex}" title="${r.name} on ${c.name}">${r.name === c.name ? '' : `${r.vs[c.name]} ${grade(r.vs[c.name])}`}</td>`).join('')}</tr>`).join('')}</table>`;
  const donts = [
    ['Stretched', `transform:scaleX(1.45)`], ['Rotated', `transform:rotate(-14deg)`], ['Off-palette colour', `filter:brightness(0) saturate(100%) invert(31%) sepia(98%) saturate(3000%) hue-rotate(300deg)`],
    ['Effects', `filter:drop-shadow(5px 6px 0 #f2a) blur(.4px)`], ['Busy background', `background:repeating-linear-gradient(45deg,#e8b 0 10px,#9cf 10px 20px)`], ['Outlined', `filter:drop-shadow(1px 0 0 #000) drop-shadow(-1px 0 0 #000) drop-shadow(0 1px 0 #000) drop-shadow(0 -1px 0 #000) brightness(3)`],
  ].map(([t, st]) => `<figure class="dont"><div class="dbox" ${t === 'Busy background' ? `style="${st}"` : ''}>${img(main, '', t === 'Busy background' ? '' : st)}</div><figcaption>✕ ${t}</figcaption></figure>`).join('');
  const lvl = { pass: '✓', warn: '!', fail: '✕' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)} — logo guide</title>
<style>${fontFace('display')}${fontFace('text')}
:root{--ink:${ink};--paper:${paper};--night:${night};--line:#e6e4df;--muted:#6f6d68}
*{box-sizing:border-box}body{margin:0;background:#fff;color:#151515;font:14px/1.5 ${fam('text', '-apple-system, system-ui, sans-serif')}}
main{max-width:1180px;margin:0 auto;padding:36px 30px 60px}section{break-inside:avoid;margin:0 0 40px}
h1{font:600 34px/1.1 ${fam('display', 'system-ui')};letter-spacing:-.02em;margin:0}h2{font:600 13px/1 ${fam('text', 'system-ui')};text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 14px;padding-top:14px;border-top:1px solid var(--line)}
p{max-width:760px;margin:0 0 12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.panel{border-radius:14px;display:grid;place-items:center;min-height:220px;padding:36px;position:relative}.panel img{max-width:70%;max-height:120px}
.light{background:var(--paper);border:1px solid var(--line)}.dark{background:var(--night)}.brand{background:var(--ink)}
.cap{position:absolute;left:14px;bottom:10px;font-size:11px;color:var(--muted)}.dark .cap,.brand .cap{color:#fff9}
.cover{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:34px}.cover img{height:76px}
.clear{position:relative;display:inline-block;padding:var(--c);outline:1px dashed #e11d48;background:repeating-linear-gradient(45deg,#e11d4810 0 6px,transparent 6px 12px)}.clear img{display:block;height:110px;background:#fff}
.clear i{position:absolute;font:11px/1 ${fam('text', 'system-ui')};color:#e11d48;font-style:normal}
.min{display:flex;gap:40px;align-items:flex-end}.min div{display:grid;gap:8px;font-size:12px;color:var(--muted)}
.sw{display:grid;gap:2px;font-size:12px}.sw b{font-size:14px}.sw span{color:var(--muted)}.chip{height:86px;border-radius:12px;border:1px solid #0001;margin-bottom:8px}
.mx{border-collapse:collapse;font-size:11px;margin-top:16px}.mx th{font-weight:600;padding:4px 8px;text-align:left}.mx td{padding:10px 12px;border:1px solid #fff;min-width:110px;font-weight:600}
.font{border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:12px}.spec{font-size:12px;color:var(--muted);margin-bottom:8px}
.dont{margin:0}.dbox{height:130px;border-radius:12px;background:var(--paper);display:grid;place-items:center;overflow:hidden}.dbox img{max-width:60%;max-height:60px}.dont figcaption{font-size:12px;color:#c0262d;margin-top:6px}
.fav{display:flex;gap:18px;align-items:flex-end}.fav img{image-rendering:pixelated}
ul.ck{list-style:none;padding:0;margin:0;columns:2;font-size:12px}ul.ck li{margin:0 0 4px;break-inside:avoid}
.files{columns:3;font:11px/1.6 ui-monospace,Menlo,monospace;color:var(--muted)}
@page{size:A4 landscape;margin:8mm}@media print{main{padding:0}section{page-break-inside:avoid}}
@media (max-width:700px){.grid,.grid3{grid-template-columns:1fr}}
</style></head><body><main>
<div class="cover"><div><h1>${esc(name)}</h1><p style="color:var(--muted);margin-top:6px">${esc(B.tagline ?? 'Logo guide')}</p></div>${img(main)}</div>
<section><h2>Logo</h2>
<div class="grid"><div class="panel light">${img(main)}<span class="cap">primary · on light</span></div><div class="panel dark">${img(mainDark)}<span class="cap">reversed · on dark</span></div></div>
<div class="grid3" style="margin-top:14px"><div class="panel light">${img(mark.svg)}<span class="cap">mark</span></div>${word ? `<div class="panel light">${img(lockups.stacked)}<span class="cap">stacked</span></div><div class="panel light">${img(word.svg)}<span class="cap">wordmark</span></div>` : ''}</div>
${B.story ? `<p style="margin-top:14px">${esc(B.story)}</p>` : ''}</section>
<section><h2>Clear space and minimum size</h2>
<p>Keep at least <b>${Math.round(clear * 100)}% of the mark's height</b> clear on every side (x below). Nothing else — text, edges, other logos — enters it.</p>
<div style="display:flex;gap:60px;align-items:center;flex-wrap:wrap"><div class="clear" style="--c:${Math.round(clear * 110)}px">${img(main)}<i style="left:4px;top:4px">x</i></div>
<div class="min"><div>${img(mark.svg, '', `width:${minSize.mark}px;height:${minSize.mark}px`)}mark ≥ ${minSize.mark}px</div>${word ? `<div>${img(main, '', `width:${minSize.lockup}px`)}lockup ≥ ${minSize.lockup}px wide</div>` : ''}
<div class="fav">${icoPngs.slice(0, 2).map((p) => `<img src="data:image/png;base64,${p.data.toString('base64')}" style="width:${p.size * 2}px;height:${p.size * 2}px">`).join('')}<span style="font-size:12px;color:var(--muted)">favicon 16 / 32 px (×2)</span></div></div></div></section>
<section><h2>Colour</h2><div class="grid3" style="grid-template-columns:repeat(${Math.min(contrast.length, 5)},1fr)">${sw}</div>${matrix}
<p style="margin-top:10px;font-size:12px;color:var(--muted)">Contrast measured (WCAG 2): AA text ≥ 4.5, large text and graphics ≥ 3.</p></section>
${fonts ? `<section><h2>Type</h2>${fonts}</section>` : ''}
<section><h2>Don't</h2><div class="grid3">${donts}</div></section>
<section><h2>Checks on the delivered mark</h2><ul class="ck">${checks.map((c) => `<li>${lvl[c.level]} <b>${esc(c.check)}</b> ${esc(c.note)}</li>`).join('')}</ul></section>
<section><h2>Files</h2><div class="files">${files.map(esc).join('<br>')}</div></section>
</main></body></html>`;
}

function grade(r) { return r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA large' : '✕'; }
