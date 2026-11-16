#!/usr/bin/env node
// Measured checks for logo marks: small sizes, one colour, light/dark, balance, artboard,
// source hygiene, and likeness to reference marks and to each other.
//
//   node measure.mjs <concepts-dir | file.svg ...> [--refs <dir>] [--json out.json]
//                    [--light '#ffffff'] [--dark '#111111'] [--fav-pad 0.06] [--strict]
//
// A concepts dir holds one folder per concept with mark.svg (concepts/<id>/mark.svg), or
// plain .svg files. --refs: SVG/PNG/JPG marks it must not resemble (competitors, the
// references you collected, the old logo). Prints one line per check and writes JSON.
// --strict exits 1 when any check fails.
import fs from 'node:fs';
import path from 'node:path';
import { launch, libPage } from './lib/chrome.mjs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './lib/args.mjs';

/** Marks to measure: [{name, file}] */
export function findMarks(inputs) {
  const out = [];
  for (const p of inputs) {
    if (fs.statSync(p).isFile()) { out.push({ name: path.basename(p, '.svg'), file: p }); continue; }
    for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.isDirectory() && fs.existsSync(path.join(p, e.name, 'mark.svg'))) out.push({ name: e.name, file: path.join(p, e.name, 'mark.svg'), dir: path.join(p, e.name) });
      else if (e.isFile() && e.name.endsWith('.svg')) out.push({ name: path.basename(e.name, '.svg'), file: path.join(p, e.name) });
    }
  }
  return out;
}

export const refsOf = (dir) => !dir ? [] : fs.readdirSync(dir).filter(f => /\.(svg|png|jpe?g|webp)$/i.test(f)).map(f => {
  const file = path.join(dir, f); const svg = f.toLowerCase().endsWith('.svg');
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[f.split('.').pop().toLowerCase()];
  return { name: f, svg, src: svg ? fs.readFileSync(file, 'utf8') : `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
});

/** Turn measurements into verdicts: [{check, level: pass|warn|fail, note}] */
/** Art drawn for dark backgrounds (mark-dark.svg, *-white.svg, reversed…) is judged on dark. */
export const forDark = (name) => /(^|[-_.])(dark|white|reversed|inverse|negative)([-_.]|$)/i.test(name);

export function verdicts(m, sim, { dark = false } = {}) {
  const v = []; const add = (check, level, note) => v.push({ check, level, note });
  if (m.empty) { add('ink', 'fail', 'nothing drawn'); return v; }
  const { big, at16, at32 } = m.structure; const s = m.small;
  // small sizes
  const lost16 = big.holes - at16.holes, lost32 = big.holes - at32.holes;
  const l16 = s.thin16 > 0.3 || s.coverage16 < 0.06 ? 'fail' : s.thin16 > 0.12 || s.mush16 > 0.45 || lost16 > 0 || at16.holes > big.holes ? 'warn' : 'pass';
  const gaps = (at) => (at.holes > big.holes ? `, ${at.holes - big.holes} gap(s) close into enclosed spots` : '');
  add('16px', l16, `${side(m)}thin ${pct(s.thin16)} of ink under 1px, blur ${pct(s.mush16)}, counters ${Math.min(at16.holes, big.holes)}/${big.holes}, parts ${at16.parts}/${big.parts}, ink ${pct(s.coverage16)}${gaps(at16)}`);
  const l32 = s.thin32 > 0.15 || lost32 > 0 || at32.parts < big.parts || at32.holes > big.holes ? 'warn' : 'pass';
  add('32px', l32, `${side(m)}thin ${pct(s.thin32)}, blur ${pct(s.mush32)}, counters ${Math.min(at32.holes, big.holes)}/${big.holes}, parts ${at32.parts}/${big.parts}${gaps(at32)}`);
  // one colour
  const shapes = big.parts + big.holes;
  const c = m.colour;
  const knock = !dark && c.whiteShare > 0.02;
  add('one colour', c.regions > shapes + 1 || knock ? 'warn' : 'pass',
    `${c.main.length} colour(s); ${c.regions} colour regions vs ${shapes} shapes in the silhouette` + (knock ? `; ${pct(c.whiteShare)} white fill acting as a knockout — cut real holes` : ''));
  // light / dark
  const minL = Math.min(...c.onLight), minD = Math.min(...c.onDark);
  if (dark) {
    add('on dark', minD >= 3 ? 'pass' : minD >= 2 ? 'warn' : 'fail', `lowest contrast ${minD.toFixed(2)}:1 (3:1 needed for graphics; drawn for dark backgrounds)`);
  } else {
    add('on light', minL >= 3 ? 'pass' : minL >= 2 ? 'warn' : 'fail', `lowest contrast ${minL.toFixed(2)}:1 (3:1 needed for graphics)`);
    add('on dark', minD >= 3 ? 'pass' : 'warn', `lowest contrast ${minD.toFixed(2)}:1` + (minD < 3 ? ' — ship a reversed version for dark backgrounds' : ''));
  }
  // balance and artboard
  const off = Math.max(Math.abs(m.balance.dx), Math.abs(m.balance.dy));
  // lettering is heavier where its x-height is: balance is judged by eye for wordmarks
  if (m.aspect >= 0.7 && m.aspect <= 1.4) add('balance', off > 8 ? 'warn' : 'pass', `ink centre off its box centre by dx ${m.balance.dx}% dy ${m.balance.dy}%` + (off > 8 ? ' — check it looks centred, nudge optically' : ''));
  const [t, r, b, l] = m.margins; const uneven = Math.max(Math.abs(t - b), Math.abs(l - r));
  add('artboard', uneven > 3 ? 'warn' : 'pass', `margins t${t} r${r} b${b} l${l}% of the side` + (uneven > 3 ? ' — centre the art in its viewBox' : ''));
  // source
  const L = m.lint; const src = [];
  if (!L.viewBox) src.push('no viewBox');
  if (L.clipped?.length) src.push(`art cut off by the viewBox at the ${L.clipped.join(', ')}`);
  if (L.text) src.push(`${L.text} <text> (convert to outlines)`);
  if (L.images) src.push(`${L.images} raster <image>`);
  if (L.filters) src.push(`${L.filters} filter`);
  if (L.gradients) src.push(`${L.gradients} gradient`);
  if (L.strokes) src.push(`${L.strokes} stroked shape(s) (union.py outlines them)`);
  add('source', L.text || L.images || !L.viewBox || L.clipped?.length ? 'fail' : L.filters || L.gradients || L.strokes ? 'warn' : 'pass',
    (src.join(', ') || 'clean paths') + ` · ${L.shapes} shapes, ${L.nodes} path commands, ${(L.bytes / 1024).toFixed(1)} KB`);
  // likeness
  if (sim) {
    const refs = sim.refs[0], peers = sim.peers[0];
    if (refs) add('unlike refs', refs.iou >= 0.85 ? 'fail' : refs.iou >= 0.72 ? 'warn' : 'pass', `closest reference ${refs.ref} (overlap ${pct(refs.iou)})`);
    if (peers) add('distinct', peers.iou >= 0.8 ? 'warn' : 'pass', `closest other concept ${peers.ref} (overlap ${pct(peers.iou)})`);
  }
  return v;
}
const side = (m) => (m.aspect > 1.4 ? 'as tall · ' : m.aspect < 0.7 ? 'as wide · ' : '');
const pct = (x) => `${Math.round(x * 100)}%`;

export async function measureAll(marks, { refs = [], light = '#ffffff', dark = '#111111', favPad = 0.06 } = {}) {
  const browser = await launch();
  try {
    const page = await libPage(browser);
    const results = [];
    const items = marks.map(mk => ({ name: mk.name, svg: true, src: fs.readFileSync(mk.file, 'utf8') }));
    // concepts (one folder each) are compared with each other; versions of one mark are not
    const concepts = items.filter((_, i) => marks[i].dir);
    const peerSim = concepts.length > 1 ? await page.eval(`LOGO.similar(${JSON.stringify(items)}, ${JSON.stringify(concepts)})`) : [];
    const refSim = refs.length ? await page.eval(`LOGO.similar(${JSON.stringify(items)}, ${JSON.stringify(refs)})`) : [];
    for (const [i, mk] of marks.entries()) {
      const m = await page.eval(`LOGO.measure(${JSON.stringify(items[i].src)}, ${JSON.stringify({ favPad, light, dark })})`);
      const sim = { refs: refSim[i]?.matches ?? [], peers: peerSim[i]?.matches ?? [] };
      results.push({ name: mk.name, file: mk.file, metrics: m, similar: sim, checks: verdicts(m, sim, { dark: forDark(path.basename(mk.file, '.svg')) }) });
    }
    return results;
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const a = parseArgs(process.argv.slice(2), ['strict']);
  if (!a._.length) { console.error('usage: node measure.mjs <concepts-dir | file.svg ...> [--refs dir] [--json out.json] [--light #fff] [--dark #111] [--fav-pad 0.06] [--strict]'); process.exit(2); }
  const marks = findMarks(a._);
  if (!marks.length) { console.error('no marks found'); process.exit(2); }
  const results = await measureAll(marks, { refs: refsOf(a.refs), light: a.light, dark: a.dark, favPad: Number(a['fav-pad'] ?? 0.06) });
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  for (const r of results) {
    console.log(`\n${r.name}  (${r.file})`);
    for (const c of r.checks) console.log(`  ${icon[c.level]}  ${c.check.padEnd(12)} ${c.note}`);
  }
  if (a.json) { fs.writeFileSync(a.json, JSON.stringify(results, null, 1)); console.log(`\n${a.json}`); }
  if (a.strict && results.some(r => r.checks.some(c => c.level === 'fail'))) process.exit(1);
}
