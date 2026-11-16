// In-page helpers for the logo scripts: rasterise SVG on a canvas, read its pixels, measure.
// Loaded into a blank headless-Chrome page by lib/chrome.mjs; everything hangs off window.LOGO.
(() => {
  const LOGO = {};
  const NS = 'http://www.w3.org/2000/svg';

  // ── SVG text ────────────────────────────────────────────────────────────
  /** Parse, give the root a viewBox, hide (or show) the construction layer, and size it. */
  LOGO.prepare = (text, { width, height, construction = false, outlineOnly = false } = {}) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.nodeName !== 'svg') throw new Error('not an SVG: ' + (doc.querySelector('parsererror')?.textContent ?? root.nodeName));
    if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', NS);
    let vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || vb.some(isNaN)) vb = [0, 0, parseFloat(root.getAttribute('width')) || 100, parseFloat(root.getAttribute('height')) || 100];
    root.setAttribute('viewBox', vb.join(' '));
    const style = doc.createElementNS(NS, 'style');
    style.textContent = construction
      ? '#construction{display:inline!important;visibility:visible!important}'
      : '#construction{display:none!important}';
    root.insertBefore(style, root.firstChild);
    if (width) root.setAttribute('width', width);
    if (height) root.setAttribute('height', height);
    root.removeAttribute('class');
    return { svg: new XMLSerializer().serializeToString(root), viewBox: vb };
  };

  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image failed to load')); i.src = src; });
  const svgUrl = (svg) => 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));

  /**
   * Draw an SVG into a w×h canvas, contained and centred, with `pad` (fraction of the
   * smaller side) on every side. `bg`: a CSS colour or null for transparent.
   * `mono`: a CSS colour — every inked pixel takes it, keeping its alpha (the silhouette).
   */
  LOGO.raster = async (text, w, h, { pad = 0, bg = null, mono = null, construction = false } = {}) => {
    const probe = LOGO.prepare(text, { construction });
    const [, , vw, vh] = probe.viewBox;
    const p = Math.round(Math.min(w, h) * pad);
    const s = Math.min((w - 2 * p) / vw, (h - 2 * p) / vh);
    const dw = vw * s, dh = vh * s;
    const { svg } = LOGO.prepare(text, { width: dw, height: dh, construction });
    const img = await loadImage(svgUrl(svg));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    if (mono) {
      g.globalCompositeOperation = 'source-in'; g.fillStyle = mono; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    }
    if (bg) {
      const out = document.createElement('canvas'); out.width = w; out.height = h;
      const o = out.getContext('2d', { willReadFrequently: true }); o.fillStyle = bg; o.fillRect(0, 0, w, h); o.drawImage(c, 0, 0);
      return out;
    }
    return c;
  };

  /** Draw an image file (PNG/JPG data URL) as a mask source: transparent PNGs by alpha, opaque ones by distance from the corner colour. */
  LOGO.rasterImage = async (src, w, h) => {
    const img = await loadImage(src);
    const s = Math.min(w / img.width, h / img.height);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
    const d = g.getImageData(0, 0, w, h).data;
    let opaque = true;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { opaque = false; break; }
    if (!opaque) return c;
    const [r0, g0, b0] = [d[0], d[1], d[2]];
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.hypot(d[i] - r0, d[i + 1] - g0, d[i + 2] - b0);
      d[i + 3] = Math.min(255, Math.max(0, (dist - 30) * 4));
    }
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    out.getContext('2d').putImageData(new ImageData(d, w, h), 0, 0);
    return out;
  };

  LOGO.png = (canvas) => canvas.toDataURL('image/png');

  // ── pixels ──────────────────────────────────────────────────────────────
  const alphaOf = (c) => {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    const a = new Float32Array(c.width * c.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
    return a;
  };
  const maskOf = (a, t = 0.5) => { const m = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) m[i] = a[i] >= t ? 1 : 0; return m; };
  const count = (m) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; };

  // square min/max filter, separable
  const morph = (m, w, h, r, erode) => {
    const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; const s = xx < 0 || xx >= w ? 0 : m[y * w + xx]; if (erode ? !s : s) { v = erode ? 0 : 1; break; } }
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; const s = yy < 0 || yy >= h ? 0 : tmp[yy * w + x]; if (erode ? !s : s) { v = erode ? 0 : 1; break; } }
      out[y * w + x] = v;
    }
    return out;
  };
  const opening = (m, w, h, r) => morph(morph(m, w, h, r, true), w, h, r, false);

  /** Connected components of `m` equal to `val`; 8-connected for ink, 4 for background. Returns sizes and whether each touches the edge. */
  const components = (m, w, h, val, eight) => {
    const lab = new Int32Array(m.length).fill(-1); const comps = []; const q = new Int32Array(m.length);
    for (let s = 0; s < m.length; s++) {
      if (m[s] !== val || lab[s] >= 0) continue;
      const id = comps.length; let head = 0, tail = 0, size = 0, edge = false;
      q[tail++] = s; lab[s] = id;
      while (head < tail) {
        const i = q[head++]; size++;
        const x = i % w, y = (i - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; if (!eight && dx && dy) continue;
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx; if (m[j] === val && lab[j] < 0) { lab[j] = id; q[tail++] = j; }
        }
      }
      comps.push({ size, edge });
    }
    return { comps, lab };
  };
  /** Ink parts and enclosed counters (holes), each at least `minArea` pixels. */
  const structure = (m, w, h, minArea) => {
    const ink = components(m, w, h, 1, true).comps.filter(c => c.size >= minArea).length;
    const holes = components(m, w, h, 0, false).comps.filter(c => !c.edge && c.size >= minArea).length;
    return { parts: ink, holes };
  };

  const bboxOf = (m, w, h) => {
    let x0 = w, y0 = h, x1 = -1, y1 = -1, sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; sx += x; sy += y; n++; }
    return n ? { x0, y0, x1, y1, cx: sx / n, cy: sy / n, n } : null;
  };

  // ── colour ──────────────────────────────────────────────────────────────
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  LOGO.contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  LOGO.hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  LOGO.rgb = (hex) => { const h = hex.replace('#', ''); const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h; return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16)); };

  /** Main colours of the opaque pixels (quantised to 4 bits per channel), share of ink each. */
  const palette = (c) => {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    const bins = new Map(); let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 250) continue; n++;
      const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4);
      const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; bins.set(k, b);
    }
    return [...bins.values()].sort((a, b) => b.n - a.n).filter(b => b.n / n >= 0.02).slice(0, 6)
      .map(b => ({ rgb: [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round), share: +(b.n / n).toFixed(3) }));
  };
  /** Colours of the opaque pixels that touch transparency: the part of the mark that meets the background. */
  const edgePalette = (c) => {
    const w = c.width, h = c.height;
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const bins = new Map(); let n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4; if (d[i + 3] < 250) continue;
      if (d[i + 3 - 4] > 128 && d[i + 3 + 4] > 128 && d[i + 3 - 4 * w] > 128 && d[i + 3 + 4 * w] > 128) continue;
      n++; const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4);
      const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; bins.set(k, b);
    }
    return [...bins.values()].sort((a, b) => b.n - a.n).filter(b => b.n / n >= 0.05).slice(0, 4)
      .map(b => ({ rgb: [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round), share: +(b.n / n).toFixed(3) }));
  };
  /** Regions that differ only by colour: connected areas of one quantised colour. */
  const colourRegions = (c, minArea) => {
    const w = c.width, h = c.height;
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const key = new Int32Array(w * h);
    for (let i = 0; i < key.length; i++) key[i] = d[i * 4 + 3] < 128 ? -1 : ((d[i * 4] >> 5) << 6 | (d[i * 4 + 1] >> 5) << 3 | (d[i * 4 + 2] >> 5));
    const seen = new Uint8Array(w * h); const q = new Int32Array(w * h); let regions = 0;
    for (let s = 0; s < key.length; s++) {
      if (key[s] < 0 || seen[s]) continue;
      let head = 0, tail = 0, size = 0; q[tail++] = s; seen[s] = 1;
      while (head < tail) {
        const i = q[head++]; size++; const x = i % w, y = (i - x) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx; if (!seen[j] && key[j] === key[s]) { seen[j] = 1; q[tail++] = j; }
        }
      }
      if (size >= minArea) regions++;
    }
    return regions;
  };

  // ── source lint ─────────────────────────────────────────────────────────
  LOGO.lint = (text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const all = [...doc.querySelectorAll('*')].filter(e => !e.closest('#construction'));
    const has = (sel) => all.filter(e => e.matches(sel)).length;
    const paths = all.filter(e => e.nodeName === 'path');
    const nodes = paths.reduce((n, p) => n + ((p.getAttribute('d') || '').match(/[a-df-z]/gi) || []).length, 0);
    const strokes = all.filter(e => { const s = e.getAttribute('stroke') || (e.getAttribute('style') || '').match(/stroke\s*:\s*([^;]+)/)?.[1]; return s && s.trim() !== 'none'; }).length;
    // geometry outside the viewBox is cut off when rendered (a round letter's overshoot, a stroke's outer half)
    const clipped = [];
    try {
      const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-9999px;top:0';
      host.innerHTML = LOGO.prepare(text, { width: 200, height: 200 }).svg; document.body.appendChild(host);
      const root = host.querySelector('svg'); const vb = root.viewBox.baseVal;
      root.querySelectorAll('#construction').forEach(e => e.remove());
      const b = root.getBBox({ stroke: true }); const eps = Math.max(vb.width, vb.height) * 0.002;
      if (b.y < vb.y - eps) clipped.push('top'); if (b.x + b.width > vb.x + vb.width + eps) clipped.push('right');
      if (b.y + b.height > vb.y + vb.height + eps) clipped.push('bottom'); if (b.x < vb.x - eps) clipped.push('left');
      host.remove();
    } catch { /* not measurable */ }
    return {
      clipped,
      bytes: text.length,
      viewBox: !!doc.documentElement.getAttribute('viewBox'),
      text: has('text, tspan, textPath'),
      fonts: /font-family|@font-face/.test(text),
      strokes, gradients: has('linearGradient, radialGradient'), filters: has('filter'),
      images: has('image'), masks: has('mask'), clipPaths: has('clipPath'),
      shapes: has('path, circle, ellipse, rect, polygon, polyline, line'), nodes,
      construction: !!doc.getElementById('construction'),
    };
  };

  // ── measure one mark ────────────────────────────────────────────────────
  /**
   * Everything the checks need. `favPad`: padding used for the favicon renders.
   * `light`/`dark`: background colours the mark must work on.
   */
  LOGO.measure = async (text, { favPad = 0.06, light = '#ffffff', dark = '#111111' } = {}) => {
    // The art's own aspect: small sizes are its short side (16px = a 16px favicon, or a
    // wordmark 16px tall). The big render keeps the aspect with a 512px short side (max 2048 long).
    const [, , vw, vh] = LOGO.prepare(text).viewBox;
    const asp = vw / vh;
    const dims = (short) => { const s = Math.min(short, 2048 / Math.max(asp, 1 / asp)); return asp >= 1 ? [Math.round(s * asp), Math.round(s)] : [Math.round(s), Math.round(s / asp)]; };
    const [W, H] = dims(512); const S = Math.min(W, H);
    const big = await LOGO.raster(text, W, H, { pad: favPad });
    const a = alphaOf(big), m = maskOf(a);
    const ink = count(m);
    if (!ink) return { empty: true, lint: LOGO.lint(text) };
    const bb = bboxOf(m, W, H);
    // structure that should survive: counters/parts at least half a 16px pixel
    const minBig = (S / 16) ** 2 * 0.5;
    const s512 = structure(m, W, H, minBig);
    const at = async (n) => {
      const [w, h] = dims(n);
      const c = await LOGO.raster(text, w, h, { pad: favPad });
      const al = alphaOf(c); const mk = maskOf(al);
      let inked = 0, mid = 0, cov = 0;
      for (const v of al) { cov += v; if (v > 0.1) { inked++; if (v > 0.25 && v < 0.75) mid++; } }
      return { ...structure(mk, w, h, 1), coverage: +(cov / al.length).toFixed(3), mush: +(inked ? mid / inked : 0).toFixed(3) };
    };
    const s16 = await at(16), s32 = await at(32);
    // thin features: ink an opening of 1px-at-16px (or at 32px) removes
    const lost = (r) => 1 - count(opening(m, W, H, r)) / ink;
    const thin16 = +lost(Math.round(S / 16 / 2)).toFixed(3);
    const thin32 = +lost(Math.round(S / 32 / 2)).toFixed(3);
    // median stroke: erosion radius that removes half the ink, as a share of the ink box's long side
    let r = 1, e = m;
    for (; r <= 64; r++) { e = morph(e, W, H, 1, true); if (count(e) <= ink / 2) break; }
    const stroke = +((2 * r + 1) / Math.max(bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1)).toFixed(3);
    // colour: all main colours, and those on the silhouette's outer edge (what meets the background)
    const cols = palette(big);
    const edge = edgePalette(big);
    const cl = (bg) => (edge.length ? edge : cols).filter(c => c.share >= 0.1).map(c => +LOGO.contrast(c.rgb, LOGO.rgb(bg)).toFixed(2));
    const regions = colourRegions(big, minBig);
    const whiteShare = cols.filter(c => lum(c.rgb) > 0.85).reduce((n, c) => n + c.share, 0);
    const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
    return {
      lint: LOGO.lint(text),
      aspect: +asp.toFixed(3),
      ink: { coverage: +(ink / (W * H)).toFixed(3), density: +(ink / (bw * bh)).toFixed(3), aspect: +(bw / bh).toFixed(3) },
      // offset of the ink's centre of mass from the centre of its own box, in % of the box
      balance: { dx: +((bb.cx - (bb.x0 + bb.x1) / 2) / bw * 100).toFixed(1), dy: +((bb.cy - (bb.y0 + bb.y1) / 2) / bh * 100).toFixed(1) },
      // empty margin of the ink inside the artboard, % of the short side (top right bottom left)
      margins: [bb.y0, W - 1 - bb.x1, H - 1 - bb.y1, bb.x0].map(v => +(v / S * 100).toFixed(1)),
      structure: { big: s512, at32: { parts: s32.parts, holes: s32.holes }, at16: { parts: s16.parts, holes: s16.holes } },
      small: { thin16, thin32, mush16: s16.mush, mush32: s32.mush, coverage16: s16.coverage },
      stroke,
      colour: { main: cols.map(c => ({ hex: LOGO.hex(c.rgb), share: c.share })), onLight: cl(light), onDark: cl(dark), regions, whiteShare: +whiteShare.toFixed(3) },
    };
  };

  // ── similarity ──────────────────────────────────────────────────────────
  /** A 64×64 silhouette, cropped to the ink and centred, for comparing shapes. */
  const silhouette = async (src, isSvg) => {
    const c = isSvg ? await LOGO.raster(src, 256, 256, { pad: 0.02 }) : await LOGO.rasterImage(src, 256, 256);
    const m = maskOf(alphaOf(c)); const bb = bboxOf(m, 256, 256); if (!bb) return null;
    const N = 64, out = document.createElement('canvas'); out.width = N; out.height = N;
    const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1, s = (N - 4) / Math.max(bw, bh);
    out.getContext('2d').drawImage(c, bb.x0, bb.y0, bw, bh, (N - bw * s) / 2, (N - bh * s) / 2, bw * s, bh * s);
    return maskOf(alphaOf(out));
  };
  const variants = (m, N = 64) => {
    const t = (f) => { const o = new Uint8Array(N * N); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const [u, v] = f(x, y); o[y * N + x] = m[v * N + u]; } return o; };
    return [m, t((x, y) => [N - 1 - x, y]), t((x, y) => [y, N - 1 - x]), t((x, y) => [N - 1 - x, N - 1 - y]), t((x, y) => [N - 1 - y, x])];
  };
  const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 0; };
  /** items: [{name, src, svg: bool}] → pairwise best IoU over mirror/rotations, for `targets` against all others. */
  LOGO.similar = async (targets, refs) => {
    const sil = async (it) => ({ ...it, m: await silhouette(it.src, it.svg) });
    const T = await Promise.all(targets.map(sil)), R = await Promise.all(refs.map(sil));
    return T.map(t => ({
      name: t.name,
      matches: R.filter(r => r.name !== t.name && r.m && t.m)
        .map(r => ({ ref: r.name, iou: +Math.max(...variants(r.m).map(v => iou(t.m, v))).toFixed(3) }))
        .sort((x, y) => y.iou - x.iou).slice(0, 3),
    }));
  };

  // ── outline and construction views ──────────────────────────────────────
  const parsePath = (d) => {
    const toks = d.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) || [];
    const anchors = [], handles = []; let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lc = null;
    const num = () => parseFloat(toks[i++]);
    while (i < toks.length) {
      if (/[a-z]/i.test(toks[i])) cmd = toks[i++];
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;
      if (C === 'Z') { x = sx; y = sy; lc = null; continue; }
      if (C === 'M') { x = ox + num(); y = oy + num(); sx = x; sy = y; anchors.push([x, y]); cmd = rel ? 'l' : 'L'; lc = null; continue; }
      if (C === 'L') { x = ox + num(); y = oy + num(); }
      else if (C === 'H') x = ox + num();
      else if (C === 'V') y = oy + num();
      else if (C === 'C' || C === 'S') {
        let c1;
        if (C === 'C') c1 = [ox + num(), oy + num()]; else c1 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
        const c2 = [ox + num(), oy + num()], e = [ox + num(), oy + num()];
        handles.push([[x, y], c1], [e, c2]); lc = c2; x = e[0]; y = e[1]; anchors.push([x, y]); continue;
      } else if (C === 'Q' || C === 'T') {
        const c = C === 'Q' ? [ox + num(), oy + num()] : lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
        const e = [ox + num(), oy + num()]; handles.push([[x, y], c], [e, c]); lc = c; x = e[0]; y = e[1]; anchors.push([x, y]); continue;
      } else if (C === 'A') { num(); num(); num(); num(); num(); x = ox + num(); y = oy + num(); }
      else { i++; continue; }
      lc = null; anchors.push([x, y]);
    }
    return { anchors, handles };
  };

  /**
   * An SVG (string) of the mark drawn as hairline outlines with anchor points and Bézier handles.
   * `construction`: the mark faded under its #construction layer instead.
   */
  LOGO.view = (text, size, { mode = 'outline', ink = '#1d4ed8', guide = '#e11d48' } = {}) => {
    const { svg } = LOGO.prepare(text, { width: size, height: size, construction: mode === 'construction' });
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-9999px;top:0'; host.innerHTML = svg; document.body.appendChild(host);
    const root = host.querySelector('svg');
    const vb = root.viewBox.baseVal; const unit = Math.max(vb.width, vb.height) / size; // user units per px
    const style = document.createElementNS(NS, 'style');
    if (mode === 'outline') {
      style.textContent = `#construction{display:none!important} path,circle,ellipse,rect,polygon,polyline,line{fill:none!important;stroke:${ink}!important;stroke-width:1px!important;vector-effect:non-scaling-stroke;opacity:1!important}`;
    } else {
      style.textContent = `svg>*:not(#construction):not(style):not(defs){opacity:.16} #construction *{vector-effect:non-scaling-stroke} #construction{color:${guide}}`;
    }
    root.appendChild(style);
    if (mode === 'outline') {
      const layer = document.createElementNS(NS, 'g'); const rootInv = root.getScreenCTM().inverse();
      const dot = (x, y, r, fill) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', r * unit); c.setAttribute('style', `fill:${fill}!important;stroke:${ink}!important;stroke-width:1px!important;vector-effect:non-scaling-stroke`); layer.appendChild(c); };
      const line = (a, b) => { const l = document.createElementNS(NS, 'line'); [['x1', a[0]], ['y1', a[1]], ['x2', b[0]], ['y2', b[1]]].forEach(([k, v]) => l.setAttribute(k, v)); l.setAttribute('style', `stroke:${ink}!important;stroke-width:.75px!important;opacity:.55!important;vector-effect:non-scaling-stroke`); layer.appendChild(l); };
      for (const el of root.querySelectorAll('path,circle,ellipse,rect,polygon,polyline')) {
        if (el.closest('#construction')) continue;
        const M = rootInv.multiply(el.getScreenCTM());
        const T = ([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(M); return [p.x, p.y]; };
        let anchors = [], handles = [];
        const n = el.nodeName, g = (k) => parseFloat(el.getAttribute(k) || 0);
        if (n === 'path') ({ anchors, handles } = parsePath(el.getAttribute('d') || ''));
        else if (n === 'circle' || n === 'ellipse') { const cx = g('cx'), cy = g('cy'), rx = n === 'circle' ? g('r') : g('rx'), ry = n === 'circle' ? g('r') : g('ry'); anchors = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]]; }
        else if (n === 'rect') { const x = g('x'), y = g('y'), w = g('width'), h = g('height'); anchors = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
        else anchors = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).reduce((a, v, i, all) => (i % 2 ? a : [...a, [v, all[i + 1]]]), []);
        for (const [a, b] of handles) { line(T(a), T(b)); dot(...T(b), 1.6, '#fff'); }
        for (const a of anchors) dot(...T(a), 2.2, ink);
      }
      root.appendChild(layer);
    }
    const out = new XMLSerializer().serializeToString(root); host.remove();
    return out;
  };

  /** Ink box of an SVG in its own user units (for lockups and clear space). */
  LOGO.inkBox = async (text) => {
    const { viewBox: [vx, vy, vw, vh] } = LOGO.prepare(text);
    const S = 1024; const c = await LOGO.raster(text, S, S, {});
    const m = maskOf(alphaOf(c), 0.2); const bb = bboxOf(m, S, S); if (!bb) return null;
    const s = Math.min(S / vw, S / vh), ox = (S - vw * s) / 2, oy = (S - vh * s) / 2;
    return { x: vx + (bb.x0 - ox) / s, y: vy + (bb.y0 - oy) / s, w: (bb.x1 - bb.x0 + 1) / s, h: (bb.y1 - bb.y0 + 1) / s, viewBox: [vx, vy, vw, vh] };
  };

  // ── kit helpers ─────────────────────────────────────────────────────────
  const parse = (text) => new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  const ser = (el) => new XMLSerializer().serializeToString(el);
  const paint = /^(none|transparent|inherit)$|^url\(/i;

  /** The SVG without its construction layer, comments, metadata and editor attributes. */
  LOGO.clean = (text) => {
    const root = parse(text);
    root.querySelectorAll('#construction, metadata, title, desc').forEach(e => e.remove());
    const walk = (n) => { for (const c of [...n.childNodes]) { if (c.nodeType === 8) c.remove(); else if (c.nodeType === 1) walk(c); } };
    walk(root);
    for (const el of [root, ...root.querySelectorAll('*')]) for (const at of [...el.attributes]) if (/^(inkscape|sodipodi|data-name|xmlns:(inkscape|sodipodi))/.test(at.name)) el.removeAttribute(at.name);
    root.removeAttribute('class');
    return ser(root).replace(/>\s+</g, '><');
  };

  /** Every paint in one colour (keeps "none" and transparency): the one-colour vector version. */
  LOGO.recolor = (text, color) => {
    const root = parse(LOGO.clean(text));
    const fix = (css) => css.replace(/((?:fill|stroke|stop-color|color)\s*:\s*)([^;}"']+)/gi, (m, k, v) => (paint.test(v.trim()) ? m : k + color));
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const k of ['fill', 'stroke', 'stop-color', 'color']) { const v = el.getAttribute(k); if (v && !paint.test(v.trim())) el.setAttribute(k, color); }
      const st = el.getAttribute('style'); if (st) el.setAttribute('style', fix(st));
      if (el.nodeName === 'style') el.textContent = fix(el.textContent);
    }
    if (!root.getAttribute('fill')) root.setAttribute('fill', color);
    return ser(root);
  };

  /** The SVG cropped to its ink (viewBox = ink box), as a string, with that box. */
  LOGO.crop = async (text) => {
    const b = await LOGO.inkBox(text); if (!b) throw new Error('empty SVG');
    const root = parse(LOGO.clean(text));
    root.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
    root.removeAttribute('width'); root.removeAttribute('height');
    return { svg: ser(root), w: b.w, h: b.h };
  };

  /**
   * Place SVGs on one artboard. parts: [{svg, x, y, h}] in artboard units (each scaled to
   * height h, keeping its aspect); returns the combined SVG string.
   */
  LOGO.compose = (parts, W, H, bg = null) => {
    const root = document.createElementNS(NS, 'svg');
    root.setAttribute('xmlns', NS); root.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (bg) { const r = document.createElementNS(NS, 'rect'); r.setAttribute('width', W); r.setAttribute('height', H); r.setAttribute('fill', bg); root.appendChild(r); }
    for (const p of parts) {
      if (p.rect) { // {rect: {x, y, width, height, rx, fill}}
        const r = document.createElementNS(NS, 'rect'); for (const [k, v] of Object.entries(p.rect)) r.setAttribute(k, v); root.appendChild(r); continue;
      }
      const el = parse(p.svg); const [, , vw, vh] = el.getAttribute('viewBox').split(/[\s,]+/).map(Number);
      const w = p.w ?? p.h * vw / vh, h = p.h ?? p.w * vh / vw;
      el.setAttribute('x', p.x); el.setAttribute('y', p.y); el.setAttribute('width', w); el.setAttribute('height', h);
      root.appendChild(document.importNode(el, true));
    }
    return ser(root);
  };

  window.LOGO = LOGO;
})();
