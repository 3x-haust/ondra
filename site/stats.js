// Anonymous visit numbers for the landing page, sent to the same PostHog project as the app
// (docs/TELEMETRY.md). No cookies, nothing kept after the tab closes: a visit id lives in sessionStorage,
// PostHog makes no person for it, and the project drops IP addresses. Do Not Track / Global Privacy Control
// and local copies of the page send nothing.
(function () {
  "use strict";
  var KEY = "phc_kR9CjET4y3vfCdvjqdef39MZr8yx8SKRmFTwL7Xgf56H";
  var HOST = "https://us.i.posthog.com";
  var nav = navigator;
  if (nav.doNotTrack === "1" || window.doNotTrack === "1" || nav.globalPrivacyControl) return;
  if (!/\.github\.io$|^ondra\./.test(location.hostname) && !/[?&]stats=1/.test(location.search)) return;
  if (KEY.indexOf("phc_") !== 0) return;

  var lang = document.documentElement.lang || "ko";
  function rid() {
    try { return crypto.randomUUID(); } catch (e) { return String(Date.now()) + Math.random().toString(16).slice(2); }
  }
  var visit;
  try { visit = sessionStorage.getItem("ondra.visit") || ""; if (!visit) sessionStorage.setItem("ondra.visit", (visit = rid())); } catch (e) { visit = rid(); }

  var queue = [];
  var timer;
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!queue.length) return;
    var body = JSON.stringify({ api_key: KEY, batch: queue.splice(0, 50) });
    // text/plain keeps it a simple request (no preflight), so it still goes out while the page closes
    try {
      if (nav.sendBeacon && nav.sendBeacon(HOST + "/batch/", new Blob([body], { type: "text/plain" }))) return;
    } catch (e) { /* fall through */ }
    try { fetch(HOST + "/batch/", { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } }); } catch (e) { /* dropped */ }
  }
  var ref = document.referrer && document.referrer.indexOf(location.origin) !== 0 ? document.referrer : "";
  var common = {
    $lib: "ondra-site",
    $process_person_profile: false,
    $session_id: visit,
    $current_url: location.origin + location.pathname,
    $host: location.host,
    $pathname: location.pathname,
    lang: lang,
  };
  function send(event, props) {
    var p = { distinct_id: visit };
    for (var k in common) p[k] = common[k];
    for (var j in props || {}) p[j] = props[j];
    queue.push({ event: event, properties: p, timestamp: new Date().toISOString() });
    if (queue.length >= 10) flush(); else if (!timer) timer = setTimeout(flush, 2000);
  }
  window.ondraStat = send;

  // the visit: where it came from (campaign tags included), screen class
  var q = new URLSearchParams(location.search);
  var pv = { $referrer: ref || "$direct", $referring_domain: ref ? new URL(ref).hostname : "$direct", $screen_width: screen.width, $viewport_width: innerWidth, mobile: matchMedia("(max-width: 720px)").matches };
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "ref"].forEach(function (k) { if (q.get(k)) pv[k] = q.get(k); });
  send("$pageview", pv);

  // how far down people read
  var marks = [25, 50, 75, 100];
  var maxPct = 0;
  function onScroll() {
    var h = document.documentElement.scrollHeight - innerHeight;
    var pct = h > 0 ? Math.round((scrollY / h) * 100) : 100;
    if (pct > maxPct) maxPct = pct;
    while (marks.length && pct >= marks[0] - 1) send("site_scrolled", { depth: marks.shift() });
  }
  addEventListener("scroll", onScroll, { passive: true });

  // which parts were seen: a section counts once half of it (or most of the screen) was in view for a second
  if ("IntersectionObserver" in window) {
    var seen = {};
    var timers = {};
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var name = e.target.id || e.target.getAttribute("aria-labelledby") || "";
        if (!name || seen[name]) return;
        var inView = e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= innerHeight * 0.6);
        if (inView && !timers[name]) {
          timers[name] = setTimeout(function () { seen[name] = 1; send("site_section_seen", { section: name.replace(/^s-/, "") }); io.unobserve(e.target); }, 1000);
        } else if (!inView && timers[name]) {
          clearTimeout(timers[name]); timers[name] = 0;
        }
      });
    }, { threshold: [0, 0.25, 0.5, 0.75] });
    document.querySelectorAll("main section").forEach(function (s) { io.observe(s); });
  }

  // clicks that matter: download, GitHub, language switch, FAQ
  function placeOf(el) {
    if (el.closest("header")) return "header";
    if (el.closest("footer")) return "footer";
    var s = el.closest("section");
    return s ? (s.id || (s.getAttribute("aria-labelledby") || "").replace(/^s-/, "") || "section") : "page";
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href");
    if (/\/releases\/latest|\/releases\/download/.test(href)) send("site_download_clicked", { place: placeOf(a) });
    else if (/github\.com\/3x-haust\/ondra\/?$/.test(href)) send("site_github_clicked", { place: placeOf(a) });
    else if (/github\.com\/3x-haust\/ondra\/releases\/?$/.test(href)) send("site_releases_clicked", { place: placeOf(a) });
    else if (a.hasAttribute("hreflang")) send("site_language_switched", { to: a.getAttribute("hreflang") });
  }, true);
  document.querySelectorAll(".faq details").forEach(function (d, i) {
    d.addEventListener("toggle", function () {
      if (d.open) send("site_faq_opened", { question: i + 1, title: (d.querySelector("summary") || {}).textContent || "" });
    });
  });

  // the film: it starts muted when it scrolls into view; sound on, how far it got and the end are what count
  var v = document.querySelector("#film video");
  if (v) {
    var got = {};
    var once = function (name, props) { if (!got[name]) { got[name] = 1; send(name, props || {}); } };
    v.addEventListener("playing", function () { once("site_film_started"); });
    v.addEventListener("volumechange", function () { if (!v.muted && v.volume > 0) once("site_film_unmuted", { at: Math.round(v.currentTime) }); });
    v.addEventListener("timeupdate", function () {
      if (!v.duration) return;
      var p = (v.currentTime / v.duration) * 100;
      [25, 50, 75].forEach(function (m) { if (p >= m) once("site_film_progress_" + m, { progress: m, sound: !v.muted }); });
    });
    v.addEventListener("ended", function () { once("site_film_finished", { sound: !v.muted }); });
    document.addEventListener("fullscreenchange", function () { if (document.fullscreenElement === v) once("site_film_fullscreen"); });
  }

  // leaving: how long and how far
  var t0 = Date.now();
  function leave() {
    if (leave.done) return; leave.done = 1;
    send("$pageleave", { seconds: Math.round((Date.now() - t0) / 1000), $prev_pageview_max_scroll_percentage: Math.min(1, maxPct / 100) });
    flush();
  }
  addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });
})();
