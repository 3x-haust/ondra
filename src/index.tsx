/* @refresh reload */
import { render } from "solid-js/web";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./styles/tokens.css";
import "./styles/core.css";
import "./styles/app.css";
import "./styles/t3.css";
import "./styles/polish-shell.css";
import "./styles/polish-chat.css";
import "./styles/polish-task.css";
import "./styles/polish-canvas.css";
import "./styles/polish-settings.css";
import "./styles/memory-tree.css";
import "./styles/context.css";
import "./styles/viz.css";
import "./styles/reverse.css";
import "./styles/panes.css";
import App from "./App";
import { Capture } from "./views/Capture";
import { VizGallery } from "./views/VizGallery";

// One bundle, two windows: the ⌥Space window loads with #capture.
const isCapture = location.hash === "#capture";
document.documentElement.classList.toggle("capture-window", isCapture);
// every chart kind with its examples, for checking them side by side (?gallery)
const isGallery = new URLSearchParams(location.search).has("gallery");
render(() => (isCapture ? <Capture /> : isGallery ? <VizGallery /> : <App />), document.getElementById("root") as HTMLElement);

// text boxes grow with what's typed (WebKit without field-sizing)
if (!CSS.supports("field-sizing", "content")) {
  const grow = (t: HTMLTextAreaElement) => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  };
  document.addEventListener("input", (e) => e.target instanceof HTMLTextAreaElement && e.target.matches(".textarea, .mem-text, .md-text") && grow(e.target), true);
  document.addEventListener("focusin", (e) => e.target instanceof HTMLTextAreaElement && e.target.matches(".textarea, .mem-text, .md-text") && grow(e.target), true);
}
