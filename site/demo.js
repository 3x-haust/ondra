// Plays the recreated Ondra scenes once each as they come into view.
// The HTML holds every scene's end state; with motion allowed (html.motion) a scene is
// rewound to its first frame and played forward. Reduced motion or no JS: end states stay.
(function () {
  "use strict";
  var doc = document.documentElement;
  var motion = doc.classList.contains("motion");
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  // ── a cancellable timeline per scene ──
  function runner() {
    var id = 0;
    return {
      start: function () { id++; var mine = id; return function (ms) {
        return new Promise(function (ok, no) { setTimeout(function () { mine === id ? ok() : no("stale"); }, ms); });
      }; },
      stop: function () { id++; }
    };
  }
  var quiet = function () {};

  // ── data-seq: an element's earlier states; the markup holds the last one ──
  function prep(scene) {
    $$("[data-seq]", scene).forEach(function (el) {
      var txt = $(".txt", el);
      el._final = { cls: el.className, text: (txt || el).textContent, fill: $$("i.f", el).length };
      el._seq = JSON.parse(el.getAttribute("data-seq"));
    });
  }
  function apply(el, st) {
    if (typeof st === "number") { $$("i", el).forEach(function (i, n) { i.classList.toggle("f", n < st); }); return; }
    var target = $(".txt", el) || el;
    el.className = st.cls;
    target.textContent = st.text;
    if (el.classList.contains("swap") || el.classList.contains("mark")) {
      el.classList.remove("in", "pop"); void el.offsetWidth;
      el.classList.add(el.classList.contains("mark") ? "pop" : "in");
    }
  }
  function stateAt(el, i) {
    if (i < el._seq.length) { var s = el._seq[i]; return typeof s === "number" ? s : { cls: s[0], text: s[1] }; }
    return el._seq.length && typeof el._seq[0] === "number" ? el._final.fill : el._final;
  }
  function rewind(scene) { $$("[data-seq]", scene).forEach(function (el) { el._i = 0; apply(el, stateAt(el, 0)); }); }
  function adv(scene, key) {
    $$('[data-k="' + key + '"][data-seq]', scene).forEach(function (el) { el._i = (el._i || 0) + 1; apply(el, stateAt(el, el._i)); });
  }
  function on(scene, step) { $$('[data-step="' + step + '"]', scene).forEach(function (el) { el.classList.add("on"); }); }
  function off(scene) { $$("[data-step]", scene).forEach(function (el) { el.classList.remove("on"); }); }

  function whenSeen(el, fn, threshold) {
    if (!("IntersectionObserver" in window)) { fn(); return; }
    var io = new IntersectionObserver(function (es) {
      if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); fn(); }
    }, { threshold: threshold || 0.35 });
    io.observe(el);
  }

  // ── hero: tabs fold into one Main ──
  var TABS = [
    ["› Reading src/router.ts", "› Reading src/auth/session.ts", "› Editing src/router.ts", "$ pnpm vitest run auth", "ok:✓ 7 passed"],
    ["› Opening localhost:3000/pricing", "› Clicking “Upgrade”", "› Taking a screenshot", "dim:✗ button not found", "› Retrying…"],
    ["› Drafting drafts/april-retro.md", "› 612 words", "q:? Publish to the blog now? (y/n)"],
    ["› Editing README.md", "› Updating install steps", "ok:Done. All tests pass."],
    ["$ pnpm up --latest", "› 14 packages updated", "$ pnpm build", "dim:… building"],
    ["dim:Context was reset.", "› What were we working on?"],
    ["$ xcrun simctl boot “iPhone 17 Pro”", "› Waiting for the device…"],
    ["› Reading openapi.yaml", "› Writing docs/api.md", "› 3 endpoints left"],
    ["› Summarizing 23 commits", "› Writing CHANGELOG.md"]
  ];
  function logLine(log, s) {
    var span = document.createElement("span");
    var m = /^(ok|q|dim):(.*)$/.exec(s);
    if (m) { span.className = m[1]; span.textContent = m[2]; } else span.textContent = s;
    log.appendChild(span);
    while (log.children.length > 9) log.removeChild(log.firstChild);
  }

  function hero(stage) {
    var r = runner();
    var tabs = $$(".tab", stage);
    var logs = tabs.map(function (t) { return $(".tab-log", t); });
    var wait = $(".wait", stage);
    var typed = $(".typed", stage);
    var send = $(".m-send", stage);
    prep(stage);

    function reset() {
      stage.classList.remove("done", "app-in");
      off(stage); rewind(stage);
      tabs.forEach(function (t) { t.getAnimations().forEach(function (a) { a.cancel(); }); t.classList.remove("look"); });
      logs.forEach(function (l, i) { l.textContent = ""; logLine(l, TABS[i][0]); });
      if (wait) wait.textContent = wait.getAttribute("data-fmt").replace("{n}", "38");
      typed.textContent = ""; typed.classList.remove("caret"); send.classList.remove("hot");
    }

    async function play() {
      var w = r.start();
      reset();
      // the tab juggling: lines stream in, the eye jumps around, one tab waits
      var order = [];
      for (var k = 1; k < 5; k++) for (var i = 0; i < TABS.length; i++) if (TABS[i][k]) order.push([i, TABS[i][k]]);
      var looks = [0, 2, 3, 5, 2], li = 0, n = 38;
      for (var s = 0; s < order.length; s++) {
        await w(95);
        logLine(logs[order[s][0]], order[s][1]);
        if (s % 6 === 0 && li < looks.length) { tabs.forEach(function (t) { t.classList.remove("look"); }); tabs[looks[li++]].classList.add("look"); }
        if (s % 7 === 6 && wait) wait.textContent = wait.getAttribute("data-fmt").replace("{n}", String(++n));
      }
      await w(500);
      tabs.forEach(function (t) { t.classList.remove("look"); });
      // fold every tab into the middle
      var box = stage.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      var shown = tabs.filter(function (t) { return t.offsetParent !== null; });
      shown.forEach(function (t, i) {
        var b = t.getBoundingClientRect();
        t.animate([{ transform: "none", opacity: 1 }, { transform: "translate(" + (cx - b.left - b.width / 2) + "px," + (cy - b.top - b.height / 2) + "px) scale(.18)", opacity: 0 }],
          { duration: 520, delay: i * 28, easing: "cubic-bezier(.32,.72,0,1)", fill: "forwards" });
      });
      await w(520 + shown.length * 28 - 120);
      stage.classList.add("app-in");
      await w(480);
      // one message to Main
      typed.classList.add("caret");
      var text = Array.from(typed.getAttribute("data-text"));
      for (var c = 0; c < text.length; c++) { typed.textContent += text[c]; await w(text.length > 45 ? 22 : 30); }
      send.classList.add("hot");
      await w(260);
      typed.textContent = ""; typed.classList.remove("caret"); send.classList.remove("hot");
      on(stage, "sent");
      await w(650);
      on(stage, "reply");
      await w(260); on(stage, "t1");
      await w(140); on(stage, "t2");
      await w(140); on(stage, "t3");
      await w(1100);
      adv(stage, "ask");
      await w(240);
      on(stage, "pop");
      await w(300);
      stage.classList.add("done");
    }

    var replay = $(".replay", stage.parentNode);
    if (replay) replay.addEventListener("click", function () { play().catch(quiet); });
    if (!motion) return;
    reset();
    whenSeen(stage, function () { play().catch(quiet); }, 0.2);
  }

  // ── verification: evidence checked line by line ──
  function proof(scene) {
    if (!motion) return;
    var w = runner().start();
    prep(scene); rewind(scene);
    var row = function (k) { return $('[data-k="' + k + '"]', scene); };
    whenSeen(scene, async function () {
      try {
        await w(350);
        for (var i = 1; i <= 2; i++) {
          row("r" + i).classList.add("checking"); await w(520);
          adv(scene, "m" + i); row("r" + i).classList.remove("checking"); await w(180);
        }
        row("r3").classList.add("checking"); await w(620);
        adv(scene, "m3"); row("r3").classList.remove("checking");
        await w(380); on(scene, "note");
        await w(1000); adv(scene, "tries");
        await w(900); adv(scene, "m3"); adv(scene, "foot"); adv(scene, "state");
        scene.classList.add("done");
      } catch (e) {}
    });
  }

  // ── canvas: nodes appear depth by depth, lines draw, cards update ──
  function canvas(scene) {
    var grid = $(".cv-grid", scene), svg = $(".cv-lines", scene);
    var nodes = $$(".node", grid), byId = {};
    nodes.forEach(function (n) { byId[n.getAttribute("data-id")] = n; });
    var narrow = window.matchMedia("(max-width: 860px)");
    var NS = "http://www.w3.org/2000/svg";

    function draw() {
      var g = grid.getBoundingClientRect();
      svg.setAttribute("viewBox", "0 0 " + g.width + " " + g.height);
      nodes.forEach(function (n) {
        var pid = n.getAttribute("data-parent"); if (!pid) return;
        var p = byId[pid].getBoundingClientRect(), c = n.getBoundingClientRect(), d;
        if (narrow.matches) {
          var x = p.left - g.left + 9, y0 = p.bottom - g.top, y1 = c.top - g.top + c.height / 2, x1 = c.left - g.left;
          d = "M" + x + " " + y0 + " V" + (y1 - 6) + " Q" + x + " " + y1 + " " + (x + 6) + " " + y1 + " H" + x1;
        } else {
          var sx = p.right - g.left, sy = p.top - g.top + p.height / 2, ex = c.left - g.left, ey = c.top - g.top + c.height / 2, mx = (sx + ex) / 2;
          d = "M" + sx + " " + sy + " C" + mx + " " + sy + " " + mx + " " + ey + " " + ex + " " + ey;
        }
        var path = n._path;
        if (!path) {
          path = n._path = document.createElementNS(NS, "path");
          path.setAttribute("pathLength", "1");
          if (n.hasAttribute("data-ask") || pid === "blog") path.setAttribute("class", "ask");
          path.setAttribute("data-depth", n.getAttribute("data-depth"));
          svg.appendChild(path);
        }
        path.setAttribute("d", d);
      });
    }
    draw();
    if ("ResizeObserver" in window) new ResizeObserver(draw).observe(grid);
    else window.addEventListener("resize", draw);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
    if (!motion) return;

    prep(scene); rewind(scene);
    var w = runner().start();
    whenSeen(scene, async function () {
      try {
        for (var d = 0; d <= 3; d++) {
          $$('path[data-depth="' + d + '"]', svg).forEach(function (p) { p.classList.add("on"); });
          if (d) await w(300);
          on(scene, "d" + d);
          await w(200);
        }
        await w(700); adv(scene, "t1"); adv(scene, "t2");
        await w(1100); adv(scene, "t1"); adv(scene, "s");
        scene.classList.add("done");
      } catch (e) {}
    }, 0.3);
  }

  // ── decision card you can answer ──
  function decide(card) {
    var opts = $$(".dc-opt", card), input = $(".dc-input", card), after = $(".dc-after", card), pill = $(".dc-task .pill", card);
    var visible = false, sel = 0, answered = false;
    var pillFinal = { cls: pill.className, text: pill.textContent };
    function select(i) {
      sel = (i + opts.length) % opts.length;
      opts.forEach(function (o, n) { o.classList.toggle("sel", n === sel); o.setAttribute("aria-selected", n === sel ? "true" : "false"); });
      if (sel === opts.length - 1) input.focus({ preventScroll: true }); else if (document.activeElement === input) input.blur();
    }
    function line(cls, icon, text) {
      var d = document.createElement("div");
      d.className = "dc-line " + cls;
      d.innerHTML = '<svg class="ico"><use href="#' + icon + '"/></svg><span></span>';
      d.lastChild.textContent = text;
      after.appendChild(d);
    }
    function choose(i) {
      if (answered) return;
      var o = opts[i], me = o.getAttribute("data-me") || input.value.trim();
      if (!me) { select(i); return; }
      answered = true; select(i);
      card.classList.add("answered");
      line("me", "i-check", me);
      var fast = !motion;
      setTimeout(function () {
        line("", o.getAttribute("data-state") === "ok" ? "i-term" : "i-flask", o.getAttribute("data-reply"));
        var ok = o.getAttribute("data-state") === "ok";
        pill.className = "pill " + (ok ? "ok" : "run");
        pill.textContent = card.getAttribute(ok ? "data-done-ok" : "data-done-run");
        var b = document.createElement("button");
        b.type = "button"; b.className = "dc-reset"; b.textContent = card.getAttribute("data-reset") || "다시 해 보기";
        b.addEventListener("click", reset);
        after.appendChild(b);
      }, fast ? 0 : 520);
    }
    function reset() {
      answered = false; after.textContent = ""; input.value = "";
      card.classList.remove("answered");
      pill.className = pillFinal.cls; pill.textContent = pillFinal.text;
      select(0);
      opts[0].focus({ preventScroll: true });
    }
    opts.forEach(function (o, i) {
      o.addEventListener("click", function () { if (o.contains(input) && !input.value.trim()) { select(i); return; } choose(i); });
      o.addEventListener("mouseenter", function () { if (!answered && document.activeElement !== input) select(i); });
    });
    input.addEventListener("focus", function () { if (sel !== opts.length - 1) select(opts.length - 1); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); choose(opts.length - 1); }
      if (e.key === "ArrowUp") { e.preventDefault(); select(sel - 1); opts[sel].focus({ preventScroll: true }); }
    });
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }, { threshold: 0.5 }).observe(card);
    document.addEventListener("keydown", function (e) {
      if (!visible || answered || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t === input) return;
      if (t !== document.body && !card.contains(t)) return;
      if (/^[1-4]$/.test(e.key)) { e.preventDefault(); var i = +e.key - 1; if (i === opts.length - 1) select(i); else choose(i); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); select(sel + (e.key === "ArrowDown" ? 1 : -1)); if (sel < opts.length - 1) opts[sel].focus({ preventScroll: true }); }
      else if (e.key === "Enter" && t === document.body) { e.preventDefault(); choose(sel); }
    });
  }

  // ── routines: runs tick in ──
  function routine(scene) {
    if (!motion) return;
    var w = runner().start();
    whenSeen(scene, async function () {
      try {
        var steps = ["d1", "d2", "d3", "d4", "d5", "d6", "gh"];
        for (var i = 0; i < steps.length; i++) { await w(steps[i] === "d4" ? 700 : 380); on(scene, steps[i]); }
        scene.classList.add("done");
      } catch (e) {}
    });
  }

  // ── another Mac: the lid closes, the work goes on ──
  function macs(scene) {
    if (!motion) return;
    prep(scene); rewind(scene);
    var lid = $(".lid", scene), w = runner().start();
    whenSeen(scene, async function () {
      try {
        await w(500);
        on(scene, "l1"); lid.classList.add("shut");
        await w(700);
        on(scene, "l2"); adv(scene, "desk");
        await w(1000); adv(scene, "desk");
        await w(700);
        lid.classList.remove("shut"); on(scene, "l3");
        await w(420); adv(scene, "lap");
        scene.classList.add("done");
      } catch (e) {}
    }, 0.45);
  }

  // ── real screenshots: tabs (view transition where supported) ──
  function realTabs() {
    var img = $("#real-img"), tabs = $$(".real-tabs [role=tab]");
    tabs.forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.getAttribute("aria-selected") === "true") return;
        var swap = function () {
          tabs.forEach(function (x) { x.setAttribute("aria-selected", x === b ? "true" : "false"); });
          img.src = b.getAttribute("data-src"); img.alt = b.getAttribute("data-alt");
        };
        if (motion && document.startViewTransition) document.startViewTransition(swap); else swap();
      });
    });
  }

  // ── intro video: its section shows once the file loads; it plays (muted) while in view ──
  function video() {
    var v = $("video[data-src]"); if (!v) return;
    var sec = v.closest("section");
    v.addEventListener("loadedmetadata", function () {
      sec.hidden = false;
      if (!motion || !("IntersectionObserver" in window)) return;
      new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(quiet); }
          else v.pause();
        });
      }, { threshold: 0.5 }).observe(v);
    });
    v.src = v.getAttribute("data-src");
  }

  // ── section reveal fallback when CSS scroll-driven animations aren't there ──
  function reveals() {
    var sd = window.CSS && CSS.supports && CSS.supports("animation-timeline: view()") && CSS.supports("animation-range: entry");
    if (!motion || sd || !("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.15 });
    $$(".rv").forEach(function (el) { io.observe(el); });
  }

  var h = $('[data-scene="hero"]'); if (h) hero(h);
  var p = $('[data-scene="proof"]'); if (p) proof(p);
  var c = $('[data-scene="canvas"]'); if (c) canvas(c);
  var d = $("#decide"); if (d) decide(d);
  var rt = $('[data-scene="routine"]'); if (rt) routine(rt);
  var m = $('[data-scene="macs"]'); if (m) macs(m);
  realTabs(); video(); reveals();
})();
