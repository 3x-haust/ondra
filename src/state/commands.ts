import { binding, type ShortcutCommand, type ShortcutId } from "../lib/shortcuts";
import { nextWaiting, stepFork } from "../views/Sidebar";
import { state, taskById } from "./store";
import { switchSpace } from "./workspace";
import { stepZoom } from "./zoom";
import { t } from "../i18n";
import { setNewTaskOpen } from "../ui/bits";
import { activeTab, canStep, closePanel, closePanelTab, goMain, newPanelTab, openBrowser, openPanel, openTask, panelOpen, panelTab, ptabs, setActiveTab, setPaletteMode, setPaletteOpen, setView, stepView, togglePanel, toggleSidebar, view, type View } from "./ui";

/** a place still there to go back to (a job can be deleted meanwhile) */
const exists = (v: View) => v.name !== "task" || !!taskById(v.id);
const job = () => { const v = view(); return v.name === "task" ? taskById(v.id) : undefined; };
/** the panel shows beside Main and a task only (canvas, memory, results, devices and settings have none) */
const panelAvailable = () => view().name === "main" || view().name === "task";
const visiblePanel = () => panelAvailable() && panelOpen();
const input = () => document.querySelector<HTMLTextAreaElement>('main .composer textarea:not(:disabled)');
/** after ⌘[ / ⌘]: back on Main or a task, the cursor is in its composer (as ⌘0 leaves it) */
const step = (dir: -1 | 1) => {
  if (!stepView(dir, exists)) return;
  setTimeout(() => {
    const v = view();
    const id = v.name === "task" ? "task-input" : v.name === "main" ? (document.getElementById("new-task-input") ? "new-task-input" : "main-input") : null;
    if (id) document.querySelector<HTMLTextAreaElement>(`#${id}:not(:disabled)`)?.focus();
  }, 30);
};
const stepTab = (dir: number) => {
  const tabs = ptabs();
  const i = tabs.findIndex((t) => t.id === activeTab());
  if (tabs.length) setActiveTab(tabs[(i + dir + tabs.length) % tabs.length].id);
};
/** the canvas in its board layout (the canvas keeps the layout as a tab of its own header) */
function showBoard() {
  setView({ name: "board" });
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.cv-mode [role="tab"]:last-child:not([aria-selected="true"])')?.click());
}
export function showCommands() {
  setPaletteMode("commands");
  setPaletteOpen(true);
}
/** label and section are Korean keys, shown in the current language; the key is the user's binding for the id */
const command = (id: ShortcutId, label: string, section: string, icon: string, run: () => void, enabled?: () => boolean, inInput = false): ShortcutCommand =>
  ({ id, label: t(label), section: t(section), icon, shortcut: binding(id), run, enabled, inInput });

/** The palette and keyboard execute the same commands and availability checks. */
export function appCommands(): ShortcutCommand[] {
  return [
    command("search", "검색", "일반", "search", () => { setPaletteMode("all"); setPaletteOpen(true); }, undefined, true),
    command("commands", "명령 보기", "일반", "list", showCommands, undefined, true),
    { id: "keys", label: t("단축키 목록"), section: t("일반"), icon: "keyboard", keys: "?", run: () => void import("../views/ShortcutSheet").then((m) => m.setSheetOpen(true)) },
    { id: "keybindings", label: t("단축키 설정"), section: t("일반"), icon: "keyboard", run: () => setView({ name: "settings", tab: "shortcuts" }) },
    command("sidebar", "사이드바 열기·닫기", "일반", "panelLeft", toggleSidebar),
    command("zoomIn", "화면 크게", "일반", "plus", () => stepZoom(1), undefined, true),
    command("zoomOut", "화면 작게", "일반", "minus", () => stepZoom(-1), undefined, true),
    command("main", "메인", "이동", "message", () => (setNewTaskOpen(null), goMain()), undefined, true),
    command("new", "새 작업", "이동", "compose", () => void import("../views/MainView").then((m) => m.startNewTask()), undefined, true),
    command("board", "캔버스", "이동", "canvas", () => setView(view().name === "board" ? { name: "main" } : { name: "board" }), undefined, true),
    { id: "boardList", label: t("보드"), section: t("이동"), icon: "board", run: showBoard },
    command("memory", "메모리", "이동", "memory", () => setView({ name: "memory" }), undefined, true),
    command("results", "결과물", "이동", "inbox", () => setView({ name: "results" }), undefined, true),
    command("devices", "디바이스", "이동", "phone", () => setView({ name: "devices" }), undefined, true),
    command("settings", "설정", "이동", "gear", () => setView({ name: "settings" }), undefined, true),
    command("back", "뒤로", "이동", "back", () => step(-1), () => canStep(-1), true),
    command("forward", "앞으로", "이동", "arrow", () => step(1), () => canStep(1), true),
    command("previousJob", "이전 작업", "이동", "back", () => { const t = stepFork(state.space, -1); if (t) openTask(t.id); }, () => !!stepFork(state.space, -1), true),
    command("nextJob", "다음 작업", "이동", "arrow", () => { const t = stepFork(state.space, 1); if (t) openTask(t.id); }, () => !!stepFork(state.space, 1), true),
    command("waiting", "다음 내 차례", "이동", "hand", () => { const t = nextWaiting(state.space); if (t) openTask(t.id); }, () => !!nextWaiting(state.space), true),
    ...state.spaces.map((s, i): ShortcutCommand => ({ id: `sp-${s.id}`, label: t("{name} 워크스페이스로 전환", { name: t(s.label) }), section: t("워크스페이스"), icon: "arrow", shortcut: i < 9 ? { code: `Digit${i + 1}`, meta: true } : undefined, inInput: true, run: () => switchSpace(s.id) })),
    // the panel and every tab it can show, in one section
    command("panel", "패널 열기·닫기", "패널", "panel", togglePanel, panelAvailable, true),
    command("flow", "작업 흐름", "패널", "branch", () => openPanel("flow"), panelAvailable, true),
    command("side", "옆 대화", "패널", "message", () => {
      if (panelOpen() && panelTab() === "side") void closePanel();
      else {
        openPanel("side");
        queueMicrotask(() => document.getElementById("side-input")?.focus());
      }
    }, panelAvailable),
    command("browser", "브라우저", "패널", "globe", () => openBrowser(), panelAvailable, true),
    ...([
      ["artifacts", "결과물 탭", "inbox"], ["changes", "변경 사항", "diff"], ["pr", "PR", "pr"],
      ["files", "파일", "file"], ["terminal", "터미널", "shell"], ["overview", "작업 정보", "list"],
    ] as const).map(([id, label, icon]) => command(id, label, "패널", icon, () => openPanel(id), () => !!job())),
    command("newTab", "새 패널 탭", "패널", "plus", newPanelTab, panelAvailable),
    command("closeTab", "패널 탭 닫기", "패널", "x", () => closePanelTab(activeTab()), visiblePanel),
    command("previousTab", "이전 패널 탭", "패널", "back", () => stepTab(-1), () => visiblePanel() && ptabs().length > 1),
    command("nextTab", "다음 패널 탭", "패널", "arrow", () => stepTab(1), () => visiblePanel() && ptabs().length > 1),
    command("focusInput", "메시지 입력", "대화|section", "message", () => input()?.focus(), () => !!input()),
  ];
}
