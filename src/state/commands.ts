import { shortcuts, type ShortcutCommand, type ShortcutId } from "../lib/shortcuts";
import { nextWaiting, stepFork } from "../views/Sidebar";
import { state, taskById } from "./store";
import { switchSpace } from "./workspace";
import { activeTab, closePanel, closePanelTab, goMain, newPanelTab, openBrowser, openPanel, openTask, panelOpen, panelTab, ptabs, setActiveTab, setPaletteMode, setPaletteOpen, setView, togglePanel, toggleSidebar, view } from "./ui";

const job = () => { const v = view(); return v.name === "task" ? taskById(v.id) : undefined; };
const panelAvailable = () => view().name !== "settings";
const visiblePanel = () => panelAvailable() && panelOpen();
const input = () => document.querySelector<HTMLTextAreaElement>('main .composer textarea:not(:disabled)');
const stepTab = (dir: number) => {
  const tabs = ptabs();
  const i = tabs.findIndex((t) => t.id === activeTab());
  if (tabs.length) setActiveTab(tabs[(i + dir + tabs.length) % tabs.length].id);
};
export function showCommands() {
  setPaletteMode("commands");
  setPaletteOpen(true);
}
const command = (id: ShortcutId, label: string, section: string, icon: string, run: () => void, enabled?: () => boolean, inInput = false): ShortcutCommand =>
  ({ id, label, section, icon, shortcut: shortcuts[id], run, enabled, inInput });

/** The palette and keyboard execute the same commands and availability checks. */
export function appCommands(): ShortcutCommand[] {
  return [
    command("search", "검색", "앱", "search", () => { setPaletteMode("all"); setPaletteOpen(true); }, undefined, true),
    command("commands", "단축키 · 명령 안내", "앱", "list", showCommands, undefined, true),
    command("main", "메인으로", "이동", "message", () => goMain()),
    command("new", "메인에게 말하기", "이동", "message", () => goMain()),
    command("settings", "설정", "앱", "gear", () => setView({ name: "settings" })),
    command("sidebar", "왼쪽 목록 접기 · 펴기", "보기", "panelLeft", toggleSidebar),
    command("board", "캔버스 (모든 일)", "이동", "canvas", () => setView(view().name === "board" ? { name: "main" } : { name: "board" })),
    command("memory", "기억", "이동", "memory", () => setView({ name: "memory" })),
    command("results", "결과", "이동", "inbox", () => setView({ name: "results" })),
    command("devices", "디바이스 허브", "이동", "phone", () => setView({ name: "devices" })),
    ...state.spaces.map((s, i): ShortcutCommand => ({ id: `sp-${s.id}`, label: `${s.label} 공간으로 전환`, section: "공간", icon: "arrow", shortcut: i < 9 ? { code: `Digit${i + 1}`, meta: true } : undefined, run: () => switchSpace(s.id) })),
    command("previousJob", "이전 일", "이동", "back", () => { const t = stepFork(state.space, -1); if (t) openTask(t.id); }, () => !!stepFork(state.space, -1)),
    command("nextJob", "다음 일", "이동", "arrow", () => { const t = stepFork(state.space, 1); if (t) openTask(t.id); }, () => !!stepFork(state.space, 1)),
    command("waiting", "다음 확인할 일", "이동", "alert", () => { const t = nextWaiting(state.space); if (t) openTask(t.id); }, () => !!nextWaiting(state.space)),
    command("panel", "패널 열기 · 닫기", "패널", "panel", togglePanel, panelAvailable),
    command("flow", "흐름 보기", "패널", "branch", () => openPanel("flow"), panelAvailable),
    command("side", "사이드챗 열기 · 닫기", "패널", "message", () => {
      if (panelOpen() && panelTab() === "side") void closePanel();
      else {
        openPanel("side");
        queueMicrotask(() => document.getElementById("side-input")?.focus());
      }
    }, panelAvailable),
    command("browser", "공유 브라우저", "패널", "globe", () => openBrowser(), panelAvailable),
    ...([
      ["artifacts", "결과물", "inbox"], ["changes", "변경 사항", "diff"], ["pr", "PR", "pr"],
      ["files", "파일", "file"], ["terminal", "셸", "shell"], ["overview", "일 정보", "list"],
    ] as const).map(([id, label, icon]) => command(id, label, "일 패널", icon, () => openPanel(id), () => !!job())),
    command("newTab", "새 패널 탭", "패널", "plus", newPanelTab, visiblePanel),
    command("closeTab", "현재 패널 탭 닫기", "패널", "x", () => closePanelTab(activeTab()), visiblePanel),
    command("previousTab", "이전 패널 탭", "패널", "back", () => stepTab(-1), () => visiblePanel() && ptabs().length > 1),
    command("nextTab", "다음 패널 탭", "패널", "arrow", () => stepTab(1), () => visiblePanel() && ptabs().length > 1),
    command("focusInput", "대화 입력창으로", "대화", "message", () => input()?.focus(), () => !!input()),
  ];
}
