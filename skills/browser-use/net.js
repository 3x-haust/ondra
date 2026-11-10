// browse: counts the page's fetch/XHR requests still open, so `browse` can tell a
// page that is waiting for data from one that is done. The app loads it into every
// page of a job's tab (AGENT_BROWSER_INIT_SCRIPTS), before the page's own scripts.
(() => {
  if (window.__browseNet) return;
  const s = (window.__browseNet = { open: 0 });
  const done = () => { s.open = Math.max(0, s.open - 1); };
  const f = window.fetch;
  if (f) {
    const wrapped = function (...a) {
      s.open++;
      return f.apply(this, a).finally(done);
    };
    wrapped.toString = () => f.toString();
    window.fetch = wrapped;
  }
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    s.open++;
    this.addEventListener("loadend", done, { once: true });
    return send.apply(this, a);
  };
  XMLHttpRequest.prototype.send.toString = () => send.toString();
})();
