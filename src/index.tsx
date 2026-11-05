/* @refresh reload */
import { render } from "solid-js/web";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./styles/tokens.css";
import "./styles/core.css";
import "./styles/app.css";
import "./styles/t3.css";
import "./styles/memory-tree.css";
import "./styles/context.css";
import App from "./App";
import { Capture } from "./views/Capture";

// One bundle, two windows: the ⌥Space window loads with #capture.
const isCapture = location.hash === "#capture";
document.documentElement.classList.toggle("capture-window", isCapture);
render(() => (isCapture ? <Capture /> : <App />), document.getElementById("root") as HTMLElement);

// text boxes grow with what's typed (WebKit without field-sizing)
if (!CSS.supports("field-sizing", "content")) {
  const grow = (t: HTMLTextAreaElement) => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  };
  document.addEventListener("input", (e) => e.target instanceof HTMLTextAreaElement && e.target.matches(".textarea, .mem-text, .md-text") && grow(e.target), true);
  document.addEventListener("focusin", (e) => e.target instanceof HTMLTextAreaElement && e.target.matches(".textarea, .mem-text, .md-text") && grow(e.target), true);
}
