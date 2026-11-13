// Shows the intro video once its file loads; until then (or if it's missing) the screenshot stays.
(function () {
  var v = document.querySelector("video[data-src]");
  if (!v) return;
  var still = document.getElementById(v.getAttribute("data-still"));
  v.addEventListener("loadedmetadata", function () {
    v.hidden = false;
    if (still) still.hidden = true;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    }
  });
  v.src = v.getAttribute("data-src");
})();
