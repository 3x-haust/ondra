// `a11y`: accessibility checks on the page (WCAG 2.2 A/AA rules that can be checked from
// the DOM), and `vitals`: the page's load and responsiveness numbers.

import Foundation

/// Our checks. Each violation: {id, impact, help, wcag, nodes:[{target:[css], html}]}.
private let a11yJS = #"""
(async (scopeSel) => {
  const root = scopeSel ? document.querySelector(scopeSel) : document.documentElement;
  if (!root) throw new Error('nothing matches ' + scopeSel);
  const out = new Map();
  const RULES = {
    'image-alt': ['critical', 'Images must have alternative text', '1.1.1'],
    'input-image-alt': ['critical', 'Image buttons must have alternative text', '1.1.1'],
    'label': ['critical', 'Form fields must have a label', '4.1.2'],
    'button-name': ['critical', 'Buttons must have a name people and screen readers can tell', '4.1.2'],
    'link-name': ['serious', 'Links must have a name', '2.4.4'],
    'color-contrast': ['serious', 'Text must have enough contrast with its background (4.5:1, large text 3:1)', '1.4.3'],
    'document-title': ['serious', 'The page must have a title', '2.4.2'],
    'html-has-lang': ['serious', 'The <html> element must say the page language (lang)', '3.1.1'],
    'frame-title': ['serious', 'Frames must have a title', '4.1.2'],
    'aria-hidden-focus': ['serious', 'Content hidden with aria-hidden must not hold focusable elements', '4.1.2'],
    'tabindex': ['serious', 'A tabindex above 0 breaks the natural focus order', '2.4.3'],
    'duplicate-id-aria': ['critical', 'IDs used by labels and ARIA must be unique', '4.1.2'],
    'aria-valid-ref': ['serious', 'aria-labelledby / aria-describedby / for must point at elements that exist', '1.3.1'],
    'list': ['serious', '<ul> and <ol> may only hold <li> (and script/template)', '1.3.1'],
    'listitem': ['serious', '<li> must be inside <ul>, <ol> or <menu>', '1.3.1'],
    'meta-viewport': ['critical', 'Zoom must not be disabled (user-scalable=no or maximum-scale under 2)', '1.4.4'],
    'heading-order': ['moderate', 'Heading levels should go down one at a time', '1.3.1'],
    'empty-heading': ['minor', 'Headings must have text', '1.3.1'],
    'landmark-one-main': ['moderate', 'The page should have one main landmark', '1.3.1'],
    'page-has-heading-one': ['moderate', 'The page should have a level-one heading', '1.3.1'],
    'nested-interactive': ['serious', 'Controls must not be nested inside other controls', '4.1.2'],
    'target-size': ['moderate', 'Click targets should be at least 24×24 px', '2.5.8'],
  };
  const css = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let s = n.tagName.toLowerCase();
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const add = (id, el, extra) => {
    if (!out.has(id)) out.set(id, []);
    const list = out.get(id);
    if (list.length < 50) list.push({ target: [el ? css(el) : 'html'], html: el ? el.outerHTML.slice(0, 200) : '', ...(extra || {}) });
  };
  const visible = (el) => {
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const byId = (id) => document.getElementById(id);
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const name = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((i) => byId(i)).filter(Boolean).map(text).join(' ').trim(); if (t) return t; }
    const al = (el.getAttribute('aria-label') || '').trim(); if (al) return al;
    if (el.labels && el.labels.length) { const t = [...el.labels].map(text).join(' ').trim(); if (t) return t; }
    if (/^(INPUT)$/.test(el.tagName) && /^(submit|reset|button)$/.test(el.type)) return el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : '');
    if (el.tagName === 'INPUT' && el.type === 'image') return el.alt || '';
    const own = text(el); if (own && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return own;
    const img = el.querySelector && el.querySelector('img[alt]:not([alt=""]), svg[aria-label], [role=img][aria-label]');
    if (img) return img.getAttribute('alt') || img.getAttribute('aria-label');
    return (el.getAttribute('title') || '').trim();
  };
  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true],summary,iframe';
  const all = (sel) => [...root.querySelectorAll(sel)];

  // page-level
  if (!scopeSel) {
    if (!document.title.trim()) add('document-title', null);
    if (!(document.documentElement.getAttribute('lang') || '').trim()) add('html-has-lang', document.documentElement);
    const vp = document.querySelector('meta[name=viewport]');
    if (vp) {
      const c = (vp.content || '').toLowerCase();
      const max = c.match(/maximum-scale\s*=\s*([\d.]+)/);
      if (/user-scalable\s*=\s*(no|0)/.test(c) || (max && parseFloat(max[1]) < 2)) add('meta-viewport', vp);
    }
    const mains = document.querySelectorAll('main,[role=main]');
    if (mains.length !== 1) add('landmark-one-main', mains[1] || document.body, { count: mains.length });
    if (!document.querySelector('h1,[role=heading][aria-level="1"]')) add('page-has-heading-one', document.body);
  }
  for (const img of all('img')) {
    if (!img.hasAttribute('alt') && !/^(presentation|none)$/.test(img.getAttribute('role') || '') && !img.getAttribute('aria-label') && !img.getAttribute('aria-labelledby') && visible(img)) add('image-alt', img);
  }
  for (const el of all('[role=img]')) if (!name(el) && visible(el)) add('image-alt', el);
  for (const el of all('input[type=image]')) if (!name(el)) add('input-image-alt', el);
  for (const el of all('input,select,textarea')) {
    if (el.tagName === 'INPUT' && /^(hidden|submit|reset|button|image)$/.test(el.type)) continue;
    if (!visible(el) && !(el.type === 'checkbox' || el.type === 'radio')) continue;
    if (!name(el)) add('label', el);
  }
  for (const el of all('button,[role=button],input[type=submit],input[type=button],input[type=reset]')) if (visible(el) && !name(el)) add('button-name', el);
  for (const el of all('a[href],[role=link]')) if (visible(el) && !name(el)) add('link-name', el);
  for (const el of all('iframe,frame')) if (!(el.getAttribute('title') || el.getAttribute('aria-label') || '').trim() && visible(el)) add('frame-title', el);
  for (const el of all('[aria-hidden=true]')) {
    const f = [...el.querySelectorAll(FOCUSABLE)].find((x) => !x.disabled && x.getAttribute('tabindex') !== '-1');
    if (f || (el.matches(FOCUSABLE) && !el.disabled)) add('aria-hidden-focus', f || el);
  }
  for (const el of all('[tabindex]')) if (parseInt(el.getAttribute('tabindex'), 10) > 0) add('tabindex', el);
  // ids that labels and ARIA point at must be unique and exist
  const counts = {};
  for (const el of document.querySelectorAll('[id]')) counts[el.id] = (counts[el.id] || 0) + 1;
  for (const el of all('[aria-labelledby],[aria-describedby],[aria-controls],label[for]')) {
    const refs = [el.getAttribute('aria-labelledby'), el.getAttribute('aria-describedby'), el.getAttribute('aria-controls'), el.getAttribute('for')].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
    for (const r of refs) {
      if (!counts[r]) add('aria-valid-ref', el, { missing: r });
      else if (counts[r] > 1) add('duplicate-id-aria', byId(r), { id: r });
    }
  }
  for (const l of all('ul,ol')) {
    const bad = [...l.children].find((c) => !/^(LI|SCRIPT|TEMPLATE)$/.test(c.tagName) && !/^(listitem|presentation|none)$/.test(c.getAttribute('role') || ''));
    if (bad && !/^(presentation|none|tablist|menu|menubar|listbox|tree)$/.test(l.getAttribute('role') || '')) add('list', l);
  }
  for (const li of all('li')) {
    const p = li.parentElement;
    if (p && !/^(UL|OL|MENU)$/.test(p.tagName) && !/^(list|directory)$/.test(p.getAttribute('role') || '')) add('listitem', li);
  }
  let last = 0;
  for (const h of all('h1,h2,h3,h4,h5,h6,[role=heading]')) {
    if (!visible(h)) continue;
    const lvl = h.getAttribute('aria-level') ? +h.getAttribute('aria-level') : +(h.tagName[1] || 2);
    if (!text(h) && !h.querySelector('img[alt]:not([alt=""])')) add('empty-heading', h);
    if (last && lvl > last + 1) add('heading-order', h, { from: last, to: lvl });
    last = lvl;
  }
  for (const el of all('a[href],button')) {
    const inner = el.querySelector('a[href],button,input:not([type=hidden]),select,textarea');
    if (inner && visible(inner)) add('nested-interactive', el);
  }
  for (const el of all('a[href],button,input[type=checkbox],input[type=radio],[role=button]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    // inline links in running text are exempt
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.parentElement && text(el.parentElement).length > text(el).length + 10) continue;
    if (r.width < 24 || r.height < 24) add('target-size', el, { size: `${Math.round(r.width)}×${Math.round(r.height)}` });
  }
  // contrast: each element that holds text itself, against the first solid background up the tree
  const rgb = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = rgb(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) bg = blend(l, bg);
    return bg;
  };
  let checked = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el && checked < 1500; el = walker.nextNode()) {
    if (!(el instanceof Element) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|OPTION)$/.test(el.tagName)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own || !visible(el)) continue;
    checked++;
    const s = getComputedStyle(el);
    if (el.disabled || el.closest('[disabled],[aria-disabled=true]')) continue;
    const fg = rgb(s.color); const bg = bgOf(el);
    if (!fg || !bg) continue;
    const f = fg.a < 1 ? blend(fg, bg) : fg;
    const L1 = lum(f), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(s.fontSize); const bold = parseInt(s.fontWeight, 10) >= 700;
    const need = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;
    if (ratio < need) add('color-contrast', el, { ratio: Math.round(ratio * 100) / 100, need, fg: s.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` });
  }
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const violations = [...out.entries()].map(([id, nodes]) => ({ id, impact: RULES[id][0], help: RULES[id][1], wcag: RULES[id][2], nodes }))
    .sort((a, b) => order[a.impact] - order[b.impact] || b.nodes.length - a.nodes.length);
  return { url: location.href, violations, rules: Object.keys(RULES).length };
})
"""#

private let vitalsJS = #"""
(async () => {
  const entries = (type) => new Promise((resolve) => {
    let done = false;
    try {
      const o = new PerformanceObserver((l) => { if (!done) { done = true; o.disconnect(); resolve(l.getEntries()); } });
      o.observe({ type, buffered: true });
      setTimeout(() => { if (!done) { done = true; o.disconnect(); resolve([]); } }, 250);
    } catch (e) { resolve([]); }
  });
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const lcpE = await entries('largest-contentful-paint');
  const shifts = (await entries('layout-shift')).filter((e) => !e.hadRecentInput);
  const events = (await entries('event')).filter((e) => e.interactionId);
  // CLS: the largest session window (gaps under 1 s, at most 5 s long)
  let cls = 0, win = 0, start = 0, prev = 0;
  for (const s of shifts) {
    if (s.startTime - prev > 1000 || s.startTime - start > 5000) { win = 0; start = s.startTime; }
    win += s.value; prev = s.startTime; cls = Math.max(cls, win);
  }
  const byInteraction = {};
  for (const e of events) byInteraction[e.interactionId] = Math.max(byInteraction[e.interactionId] || 0, e.duration);
  const inps = Object.values(byInteraction).sort((a, b) => b - a);
  const r = (v) => (v == null ? null : Math.round(v));
  const lcp = lcpE.length ? lcpE[lcpE.length - 1] : null;
  return {
    url: location.href,
    lcp: r(lcp && lcp.startTime), lcpElement: lcp && lcp.element ? (lcp.element.tagName.toLowerCase() + (lcp.element.id ? '#' + lcp.element.id : '')) : null,
    cls: Math.round(cls * 1000) / 1000,
    inp: inps.length ? r(inps[Math.min(inps.length - 1, Math.floor(inps.length / 50))]) : null,
    fcp: r(fcp && fcp.startTime), ttfb: r(nav.responseStart),
    domContentLoaded: r(nav.domContentLoadedEventEnd), load: r(nav.loadEventEnd),
    transferKB: nav.transferSize != null ? Math.round(nav.transferSize / 1024) : null,
    resources: performance.getEntriesByType('resource').length,
  };
})()
"""#

extension Daemon {
    func a11y(_ a: Args) throws -> Outcome {
        let t = try tab()
        if let url = a.pos.first { try navigate(t, url, waitUntil: "load") }
        let v = try evalValue(t, "(\(a11yJS))(\(a["selector"].map { jsonString($0) } ?? "null"))", timeout: 120) as? JSON ?? [:]
        let list = v.arr("violations") as? [JSON] ?? []
        let lines = list.map { x -> String in
            let nodes = x.arr("nodes") as? [JSON] ?? []
            let first = (nodes.first?.arr("target") as? [String])?.first ?? ""
            return "\(x.str("impact") ?? "") \(x.str("id") ?? "") ×\(nodes.count) \(first) — \(x.str("help") ?? "")"
        }
        return Outcome(v, lines.isEmpty ? "✓ No violations (\(v.int("rules") ?? 0) rules checked)" : lines.joined(separator: "\n"))
    }

    func vitals(_ a: Args) throws -> Outcome {
        let t = try tab()
        if let url = a.pos.first { try navigate(t, url, waitUntil: "load") }
        let v = try evalValue(t, vitalsJS) as? JSON ?? [:]
        func ms(_ k: String) -> String { v.int(k).map { "\($0) ms" } ?? "–" }
        let text = "LCP \(ms("lcp")) · CLS \(v.dbl("cls").map { String($0) } ?? "–") · INP \(ms("inp")) · FCP \(ms("fcp")) · TTFB \(ms("ttfb")) · load \(ms("load"))"
        return Outcome(v, text)
    }
}
