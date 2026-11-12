// In-memory data for the space UI preview. It never reads or writes the app's saved state.
import type { Memory, Project, Space, Status } from "../state/types";

export interface Computer { id: string; name: string; local: boolean; online: boolean; access: string[] }
export interface Work { id: string; space: string; project?: string; title: string; computer: string; status: Status; step: string }
export interface Message { id: string; space: string; text: string; reply: string; work: string }
export interface SpaceModel {
  spaces: Space[];
  projects: Project[];
  computers: Computer[];
  selected: Record<string, string | null>;
  work: Work[];
  messages: Message[];
  memory: Memory[];
  next: number;
}
export type Scenario = "simple" | "devices" | "spaces" | "multi" | "offline";

export function makeSpaceModel(scenario: Scenario = "multi"): SpaceModel {
  const manySpaces = ["spaces", "multi", "offline"].includes(scenario);
  const remote = ["devices", "multi", "offline"].includes(scenario);
  const spaces: Space[] = [{ id: "personal", label: "개인", folder: "~/Projects", rules: "" }];
  if (manySpaces) spaces.push({ id: "studio", label: "스튜디오", folder: "~/Studio", rules: "" });
  const projects: Project[] = scenario === "simple" ? [] : [{ id: "portfolio", space: "personal", name: "포트폴리오", folder: "~/Projects/portfolio" }];
  if (manySpaces) projects.push({ id: "website", space: "studio", name: "웹사이트", folder: "~/Studio/website" });
  const computers: Computer[] = [{ id: "local", name: "이 Mac", local: true, online: true, access: spaces.map((s) => s.id) }];
  if (remote) computers.push({ id: "mini", name: "Mac mini", local: false, online: scenario !== "offline", access: ["personal"] });
  const computer = remote ? "mini" : "local";
  const work: Work[] = scenario === "simple" ? [] : [
    { id: "mobile", space: "personal", project: "portfolio", title: "모바일 화면 점검", computer, status: "running", step: "메뉴와 입력창을 확인하고 있어요" },
    { id: "images", space: "personal", project: "portfolio", title: "이미지 용량 줄이기", computer: "local", status: "done", step: "이미지 크기를 맞췄어요" },
  ];
  if (manySpaces) work.push({ id: "contact", space: "studio", project: "website", title: "문의 폼 개선", computer: "local", status: "paused", step: "입력 항목을 정리했어요" });
  const memory: Memory[] = [
    { id: "personal-language", text: "설명은 한국어로 짧게 써요.", scope: "space", space: "personal", kind: "preference", source: "ondra", createdAt: 1, uses: 3 },
    { id: "personal-style", text: "새 라이브러리보다 기존 구성요소를 먼저 써요.", scope: "space", space: "personal", kind: "rule", source: "ondra", createdAt: 2, uses: 2 },
  ];
  if (scenario !== "simple") memory.push({ id: "portfolio-menu", text: "모바일 메뉴는 한 손으로 열 수 있게 배치해요.", scope: "project", space: "personal", project: projects[0].folder, kind: "decision", source: "ondra", createdAt: 3, uses: 2 });
  if (manySpaces) memory.push(
    { id: "studio-tone", text: "고객에게 보내는 문서는 존댓말로 작성해요.", scope: "space", space: "studio", kind: "rule", source: "ondra", createdAt: 4, uses: 2 },
    { id: "website-contact", text: "문의 폼에서는 연락처를 선택 항목으로 둬요.", scope: "project", space: "studio", project: "~/Studio/website", kind: "decision", source: "ondra", createdAt: 5, uses: 1 },
  );
  return {
    spaces, projects, computers, work, memory, next: 1,
    selected: Object.fromEntries(spaces.map((s) => [s.id, s.id === "personal" ? computer : "local"])),
    messages: scenario === "simple" ? [] : [{ id: "first", space: "personal", text: "포트폴리오의 모바일 화면을 점검해 줘", reply: "모바일 메뉴와 입력창부터 살펴볼게요.", work: "mobile" }],
  };
}

export const computersIn = (m: SpaceModel, space: string) => m.computers.filter((c) => c.access.includes(space));
export const selectedComputer = (m: SpaceModel, space: string) => computersIn(m, space).find((c) => c.id === m.selected[space]);
export const canSend = (m: SpaceModel, space: string) => !!selectedComputer(m, space)?.online;
export const showSpacePicker = (m: SpaceModel) => m.spaces.length > 1;
export const showComputerPicker = (m: SpaceModel, space: string) => computersIn(m, space).length > 1 || !canSend(m, space);
export const workState = (m: SpaceModel, w: Work): Status | "unknown" => w.status === "running" && !m.computers.find((c) => c.id === w.computer)?.online ? "unknown" : w.status;
export const memoriesIn = (m: SpaceModel, space: string, project?: string) => m.memory.filter((x) => x.space === space && !x.invalidAt && (project ? x.scope === "project" && x.project === project : x.scope === "space"));

export function selectComputer(m: SpaceModel, space: string, id: string): SpaceModel {
  if (!computersIn(m, space).some((c) => c.id === id && c.online)) return m;
  return { ...m, selected: { ...m.selected, [space]: id } };
}
export function connectComputer(m: SpaceModel, name: string, access: string[]): SpaceModel {
  const allowed = m.spaces.filter((s) => access.includes(s.id)).map((s) => s.id);
  if (!name.trim() || !allowed.length) return m;
  return { ...m, next: m.next + 1, computers: [...m.computers, { id: `computer-${m.next}`, name: name.trim(), access: allowed, online: true, local: false }] };
}
export function setAccess(m: SpaceModel, id: string, access: string[]): SpaceModel {
  if (!m.computers.some((c) => c.id === id)) return m;
  const allowed = m.spaces.filter((s) => access.includes(s.id)).map((s) => s.id);
  const selected = { ...m.selected };
  for (const [space, computer] of Object.entries(selected)) if (computer === id && !allowed.includes(space)) selected[space] = null;
  return { ...m, computers: m.computers.map((c) => c.id === id ? { ...c, access: allowed } : c), selected };
}
export function setOnline(m: SpaceModel, id: string, online: boolean): SpaceModel {
  return { ...m, computers: m.computers.map((c) => c.id === id && !c.local ? { ...c, online } : c) };
}
export function addSpace(m: SpaceModel, label: string): SpaceModel {
  if (!label.trim()) return m;
  const id = `space-${m.next}`;
  return { ...m, next: m.next + 1, spaces: [...m.spaces, { id, label: label.trim(), folder: "", rules: "" }], computers: m.computers.map((c) => c.local ? { ...c, access: [...c.access, id] } : c), selected: { ...m.selected, [id]: m.computers.find((c) => c.local)?.id ?? null } };
}
export function sendMessage(m: SpaceModel, space: string, text: string, project?: string): SpaceModel {
  const c = selectedComputer(m, space);
  if (!text.trim() || !c?.online || !m.spaces.some((s) => s.id === space)) return m;
  const p = m.projects.find((p) => p.id === project && p.space === space);
  const id = `work-${m.next}`;
  return { ...m, next: m.next + 1,
    work: [...m.work, { id, space, project: p?.id, title: text.trim(), computer: c.id, status: "queued", step: "시작 대기" }],
    messages: [...m.messages, { id: `message-${m.next}`, space, text: text.trim(), reply: "작업을 준비했어요.", work: id }],
  };
}
