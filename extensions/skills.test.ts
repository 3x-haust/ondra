import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
// the engine provides these at run time
vi.mock("@earendil-works/pi-coding-agent", () => ({ loadSkills: () => ({ skills: [], diagnostics: [] }), stripFrontmatter: (s: string) => s, parseFrontmatter: () => ({ frontmatter: {}, body: "" }) }));
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
import { freshState, setState } from "../src/state/store";
import type { Task } from "../src/state/types";
import { CAPTAIN_SYSTEM, handoffPrompt, SUB_SYSTEM, TASK_SYSTEM, taskPrompt } from "../src/engine/prompts";
import { skillLine } from "../src/engine/agentTools";
import { CROSSCHECK, PLAN_REVIEW, REVIEW_FIX } from "../src/engine/crosscheck";
import { runMessage } from "../src/engine/routines";
import { fromJob } from "../src/engine/jobs";
import { messageHint, searchSkills, SkillRouter, skillHint, taskQuery, toolHint, triggersOf, userWords, type Triggers } from "./skills";

// The bundled skills as the engine reads them: name and (folded) description from the frontmatter.
const root = resolve("skills");
const bundled = readdirSync(root).flatMap((dir) => {
  const filePath = join(root, dir, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const front = text.split("\n---")[0].split("\n").slice(1);
  const name = front.find((l) => l.startsWith("name:"))!.slice(5).trim();
  const at = front.findIndex((l) => l.startsWith("description:"));
  const inline = front[at].slice(12).trim();
  const folded = front.slice(at + 1).filter((_, i, all) => all.slice(0, i + 1).every((l) => l.startsWith("  "))).map((l) => l.trim());
  const description = (/^>-?$/.test(inline) ? folded : [inline]).join(" ");
  return [{ name, description, filePath, baseDir: join(root, dir), disableModelInvocation: false }];
}) as unknown as Parameters<typeof searchSkills>[0];

const top = (query: string) => searchSkills(bundled, query, 3).map((s) => s.name);

describe("skill matching", () => {
  it("reads every bundled skill", () => {
    expect(bundled.map((s) => s.name)).toEqual(expect.arrayContaining(["reverse-engineering", "computer-use", "visual-report", "deep-research", "mimikyu", "qa", "stack-diagram"]));
  });

  it("maps a question about how another tool works to reverse engineering", () => {
    expect(top("다른 앱의 컴퓨터유즈가 어떻게 동작하는지 분석")[0]).toBe("reverse-engineering");
    expect(skillHint(bundled, "다른 앱의 컴퓨터유즈가 어떻게 동작하는지 분석")).toContain("- reverse-engineering:");
  });

  it.each([
    ["이 앱 바이너리를 분석해줘", "reverse-engineering"],
    ["경쟁사 리서치해서 정리해줘", "deep-research"],
    ["피그마 그대로 만들어줘", "mimikyu"],
    ["웹 디자인 방향을 잡아줘", "web-design"],
    ["디자인 토큰과 디자인 규칙을 정리해줘", "web-design"],
    ["DESIGN.md design system", "web-design"],
    ["랜딩 페이지 디자인", "web-design"],
    ["포트폴리오 디자인", "web-design"],
    ["매출 차트 보고서 만들어줘", "visual-report"],
    ["우리 스택 아키텍처 다이어그램 그려줘", "stack-diagram"],
    ["draw our system architecture diagram with logos", "stack-diagram"],
    ["모션그래픽 만들어줘", "motion-graphics"],
    ["제품 홍보 영상 만들어줘", "motion-graphics"],
    ["인스타 릴스용 키네틱 타이포 영상", "motion-graphics"],
    ["make a launch film for the app", "motion-graphics"],
    ["로고 만들어줘", "logo-design"],
    ["우리 카페 로고 디자인해줘", "logo-design"],
    ["브랜드 키트랑 파비콘 만들어줘", "logo-design"],
    ["design a logo for my startup", "logo-design"],
    ["메모 앱에서 버튼 눌러줘 컴퓨터유즈로", "computer-use"],
    ["이 웹앱 QA 해줘", "qa"],
    ["앱 화면 다 눌러봐", "qa"],
    ["버그 찾아줘", "qa"],
    ["출시 전에 점검해줘", "qa"],
    ["완벽하게 테스트해줘", "qa"],
    ["find bugs in the checkout flow", "qa"],
    ["dogfood the site before launch", "qa"],
    ["테스트 짜줘", "test-ci"],
    ["이 엑셀 파일 정리해줘", "office-docs"],
    ["워드 문서로 만들어줘", "office-docs"],
    ["PPT 만들어줘", "office-docs"],
    ["이 프로젝트 앱 확인 스킬 만들어줘", "app-check"],
    ["앱 확인 스킬 점검해줘", "app-check-upkeep"],
    ["merge these PDF files", "office-docs"],
    ["코드 설명해줘", "code-map"],
    ["이 레포 어떻게 돼 있어", "code-map"],
    ["구조 설명해줘", "code-map"],
    ["아키텍처 지도 그려줘", "code-map"],
    ["explain this codebase", "code-map"],
  ])("%s → %s", (query, skill) => {
    expect(top(query)[0]).toBe(skill);
    expect(skillHint(bundled, query)).toContain(`- ${skill}:`);
  });

  it("lists nothing when no skill clearly fits", () => {
    expect(skillHint(bundled, "README 오타 고쳐줘")).toBe("");
  });
});

describe("taskQuery", () => {
  const t: Task = {
    id: "t1", space: "home", topic: "ondra", title: "컴퓨터유즈 분석", ask: "다른 앱의 컴퓨터유즈가 어떻게 동작하는지 분석",
    cwd: "/repo", status: "queued", priority: 2, weight: "light", accountId: "default", createdAt: 1,
    now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  };
  beforeEach(() => setState(reconcile(freshState())));

  it("takes the title and the ask from a job's first message", () => {
    const q = taskQuery(taskPrompt(t))!;
    expect(q).toContain("컴퓨터유즈 분석");
    expect(q).toContain(t.ask);
    expect(q).not.toContain("Folder:");
  });

  it("takes the original task from a new session's first message", () => {
    const q = taskQuery(handoffPrompt({ ...t, legs: [{ startedAt: 1, endedAt: 2, handoff: { did: ["읽었어요"], next: "정리", evidence: [] } }, { startedAt: 2 }] }))!;
    expect(q).toContain(t.ask);
    expect(q).not.toContain("읽었어요");
  });

  it("ignores messages that aren't a job's first", () => {
    expect(taskQuery("(Ondra가 다시 시작됐어요. 하던 일을 이어서 하세요.)")).toBeUndefined();
    expect(taskQuery("다시 확인해줘")).toBeUndefined();
  });
});

// The bundled skills' own triggers, read from their frontmatter metadata lines.
const triggers = new Map<string, Triggers>(
  bundled.map((s) => {
    const text = readFileSync(s.filePath, "utf8");
    const front = text.split("\n---")[0].split("\n");
    const at = front.findIndex((l) => l === "metadata:");
    const metadata: Record<string, string> = {};
    for (const l of at < 0 ? [] : front.slice(at + 1)) {
      const m = l.match(/^  ([\w-]+): '(.*)'$/);
      if (!m) break;
      metadata[m[1]] = m[2];
    }
    return [s.name, triggersOf({ metadata })];
  }),
);
const router = () => new SkillRouter(bundled, triggers);

describe("skill router", () => {
  it("offers a skill when a tool steps into its domain, once", () => {
    const r = router();
    expect(r.forTool("bash", { command: "ondra-browser open https://example.com" })?.skill.name).toBe("browser-use");
    expect(r.forTool("bash", { command: "ondra-browser snapshot" })).toBeUndefined();
    expect(r.forTool("bash", { command: "otool -L /Applications/Foo.app/Contents/MacOS/Foo" })?.skill.name).toBe("reverse-engineering");
    expect(r.forTool("write", { path: ".github/workflows/ci.yml" })?.skill.name).toBe("test-ci");
    expect(r.forTool("computer", {})?.skill.name).toBe("computer-use");
    expect(r.forTool("device", {})?.skill.name).toBe("device-use");
    // the skill's own `browse` steps into it too
    expect(router().forTool("bash", { command: "browse open https://example.com" })?.skill.name).toBe("browser-use");
    // an office file read or written
    expect(router().forTool("read", { path: "/Users/me/Downloads/견적서.xlsx" })?.skill.name).toBe("office-docs");
    expect(router().forTool("write", { path: "out/report.docx" })?.skill.name).toBe("office-docs");
  });

  it("offers the web guides for web UI code, not for other work", () => {
    expect(router().forMessage("설정 화면 모달을 팝오버로 바꾸고 접근성도 챙겨줘").map((s) => s.name)).toContain("modern-web-guidance");
    expect(router().forMessage("README 오타 고쳐줘").map((s) => s.name)).not.toContain("modern-web-guidance");
  });

  it("leaves ordinary work alone", () => {
    const r = router();
    expect(r.forTool("bash", { command: "pnpm install && git status" })).toBeUndefined();
    expect(r.forTool("read", { path: "src/App.tsx" })).toBeUndefined();
    expect(r.forTool("edit", { path: "src/views/Results.tsx" })).toBeUndefined();
  });

  it("does not offer a skill the model has read", () => {
    const r = router();
    const browser = bundled.find((s) => s.name === "browser-use")!;
    r.forTool("read", { path: browser.filePath });
    expect(r.loaded.has("browser-use")).toBe(true);
    expect(r.forTool("bash", { command: "ondra-browser open x" })).toBeUndefined();
    expect(r.forMessage("ondra-browser로 사이트 열어서 브라우저로 확인해줘").map((s) => s.name)).not.toContain("browser-use");
  });

  it("reads every message, not only the first, and a link in it", () => {
    const r = router();
    expect(r.forMessage("README 오타 고쳐줘")).toEqual([]);
    expect(r.forMessage("이제 이 앱 바이너리를 분석해줘").map((s) => s.name)).toContain("reverse-engineering");
    expect(r.forMessage("https://www.figma.com/design/abc/Page?node-id=1-2 이대로").map((s) => s.name)[0]).toBe("mimikyu");
    // said once is enough until the conversation is compacted
    expect(r.forMessage("바이너리 하나 더 분석")).toEqual([]);
    r.reset();
    expect(r.forMessage("바이너리 하나 더 분석").map((s) => s.name)).toContain("reverse-engineering");
  });

  it("writes hints that name the skill and its file", () => {
    const re = bundled.find((s) => s.name === "reverse-engineering")!;
    expect(messageHint([re], false)).toContain(`- reverse-engineering:`);
    expect(messageHint([re], true)).toContain("# Skills for this task");
    expect(messageHint([], false)).toBe("");
    expect(toolHint(re, "runs a command of its domain")).toContain(re.filePath);
  });
});

describe("qa skill", () => {
  const qa = bundled.find((s) => s.name === "qa")!;
  const body = readFileSync(qa.filePath, "utf8");

  it("is named for QA requests in every role's skill list", () => {
    for (const prompt of [CAPTAIN_SYSTEM, TASK_SYSTEM, SUB_SYSTEM]) expect(prompt).toMatch(/QA[^\n]*→ qa/);
    expect(skillLine(qa)).toBe("앱을 직접 써 보며 버그를 찾아요");
  });

  it("drives each surface through the skill that owns it and ships its helpers", () => {
    for (const skill of ["browser-use", "device-use", "computer-use", "test-ci", "goal-loop", "visual-report"]) expect(body).toContain(`\`${skill}\``);
    expect(statSync(join(qa.baseDir, "sweep.sh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(qa.baseDir, "references", "checklist.md"), "utf8")).toContain("## Inputs");
  });

  it("reports only unless asked to fix, and keeps real accounts and passwords out", () => {
    expect(body).toMatch(/Report-only\*\* \(default\)/);
    expect(body).toContain("Never** use real customers' accounts");
    expect(body).toContain("Never type, paste or print a password");
  });
});

describe("userWords", () => {
  it("keeps only the user's message from main's turn", () => {
    const turn = "# This chat\n테스트와 타입 검사를 돌려요. plan 먼저\n\n# Projects in this space (name: folder)\n- app: ~/app\n\n# Message\n빌드 왜 실패했어?";
    expect(userWords(turn)).toBe("빌드 왜 실패했어?");
    expect(userWords("# A fork you started has ended (not a user message)\n테스트 다 통과\n\nsay what it did")).toBe("");
  });
  it("drops the notes the app sends by itself", () => {
    expect(userWords("(Ondra가 다시 시작됐어요. 돌던 명령이 끊겼으면 그 로그부터 확인하세요. 하던 일을 이어서 하세요. 이미 보낸 plan은 다시 보내지 마세요.)")).toBe("");
    expect(userWords("(Ondra) Your to-do list hasn't moved for a while.")).toBe("");
    expect(userWords("끝내기 전에 빠진 게 있어요.\n- done에 evidence가 없어요.")).toBe("");
    expect(userWords(`${CROSSCHECK} 결과가 왔어요 (설계 · 코드):\n\n${REVIEW_FIX}`)).toBe("");
    expect(userWords(`${PLAN_REVIEW}가 둘 다 실패했어요.`)).toBe("");
    expect(userWords(`리뷰 결과가 왔어요 ("코드 리뷰"):\n\nP2 하나\n\n${REVIEW_FIX}`)).toBe("");
    expect(userWords(`서브에이전트 "테스트 짜기" 완료: 테스트 12개 추가`)).toBe("");
  });
  it("keeps what a routine asks and what another job says", () => {
    const run = runMessage({ title: "아침 정리", when: { kind: "daily", at: "09:00" }, runs: 0, prompt: "어제 PR 리뷰해 줘" } as never, 0);
    expect(userWords(run)).toBe("어제 PR 리뷰해 줘");
    expect(userWords(fromJob({ title: "A", id: "t1" } as Task, "테스트 깨졌어요"))).toBe("테스트 깨졌어요");
  });
  it("leaves the user's own words as they are", () => {
    expect(userWords("\"어떻게 할까요?\" → 로그인 화면만")).toBe("\"어떻게 할까요?\" → 로그인 화면만");
  });
});

describe("a project's own skills", () => {
  it("are found in its folder and up to the repo root, never at home", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { projectSkillDirs } = await import("./skills");
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const repo = join(home, "code", "app");
    mkdirSync(join(repo, ".agents", "skills", "check-app"), { recursive: true });
    mkdirSync(join(repo, "web", ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, "code", ".cursor", "skills"), { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: elsewhere");
    expect(projectSkillDirs(join(repo, "web"), home)).toEqual([join(repo, "web", ".claude", "skills"), join(repo, ".agents", "skills")]);
    // a folder that isn't a repo: up to home, not home itself
    expect(projectSkillDirs(join(home, "code"), home)).toEqual([join(home, "code", ".cursor", "skills")]);
    expect(projectSkillDirs(home, home)).toEqual([]);
  });
});

describe("checking in the app", () => {
  it("is in a job's rules unless turned off, and names the skills", async () => {
    const { appCheckRules } = await import("../src/engine/prompts");
    setState("settings", "appCheck", undefined);
    expect(appCheckRules()).toContain("app-check");
    expect(appCheckRules()).toContain("check-<app>");
    setState("settings", "appCheck", false);
    expect(appCheckRules()).toBe("");
    setState("settings", "appCheck", undefined);
  });
  it("ships both skills with frontmatter that loads", () => {
    for (const name of ["app-check", "app-check-upkeep"]) {
      const text = readFileSync(join(__dirname, "..", "skills", name, "SKILL.md"), "utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
      expect(text).toContain("MIT, Lauren Tan");
    }
  });
});

describe("logo-design skill", () => {
  const logo = bundled.find((s) => s.name === "logo-design")!;
  const body = readFileSync(logo.filePath, "utf8");

  it("is named for logo requests in every role's skill list", () => {
    for (const prompt of [CAPTAIN_SYSTEM, TASK_SYSTEM, SUB_SYSTEM]) expect(prompt).toMatch(/로고[^\n]*\n?[^\n]*→ logo-design/);
    expect(skillLine(logo)).toBe("로고와 브랜드 키트를 만들어요");
  });

  it("ships its scripts executable and shows how to call each one", () => {
    for (const script of ["contact.mjs", "measure.mjs", "sheet.mjs", "render.mjs", "kit.mjs", "outline.py", "union.py"]) {
      expect(statSync(join(logo.baseDir, "scripts", script)).mode & 0o111).not.toBe(0);
      expect(body).toContain(script);
    }
    for (const ref of ["craft.md", "kit.md", "fonts.md"]) expect(statSync(join(logo.baseDir, "references", ref)).isFile()).toBe(true);
  });

  it("is offered when the work runs its scripts or writes a favicon", () => {
    expect(router().forTool("bash", { command: "node skills/logo-design/scripts/sheet.mjs concepts/ review/" })?.skill.name).toBe("logo-design");
    expect(router().forTool("write", { path: "public/favicon.svg" })?.skill.name).toBe("logo-design");
    expect(router().forTool("write", { path: "src/components/Logo.tsx" })).toBeUndefined();
  });
});

describe("code-map skill", () => {
  const map = bundled.find((s) => s.name === "code-map")!;
  const body = readFileSync(map.filePath, "utf8");
  const script = join(map.baseDir, "scripts", "codemap.mjs");

  it("ships its script executable, shows each command, and credits Groma", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
    for (const cmd of ["where", "survey", "check --stamp", "owner", "blocks --container", "from-groma"]) expect(body).toContain(`codemap ${cmd}`);
    expect(readFileSync(join(map.baseDir, "NOTICE.md"), "utf8")).toContain("Copyright (c) 2026 Alex Gavrilescu");
    expect(readFileSync(join(map.baseDir, "references", "format.md"), "utf8")).toContain("## Fields");
    expect(skillLine(map)).toBe("코드 구조를 지도로 그려 설명하고 최신으로 지켜요");
  });

  it("is offered when a job reads the map or runs the script, not for ordinary reads", () => {
    expect(router().forTool("read", { path: "/r/.git/ondra/code-map/map.json" })?.skill.name).toBe("code-map");
    expect(router().forTool("bash", { command: "node ~/x/code-map/scripts/codemap.mjs owner src/a.ts" })?.skill.name).toBe("code-map");
    expect(router().forTool("read", { path: "src/map.ts" })).toBeUndefined();
  });

  it("checks a map against a real repo, names a file's owner and draws the map as blocks", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const repo = mkdtempSync(join(tmpdir(), "codemap-"));
    const sh = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", HOME: repo } });
    const run = (...args: string[]) => {
      try {
        return { code: 0, out: sh(process.execPath, script, ...args) };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: err.stdout };
      }
    };
    mkdirSync(join(repo, "web"), { recursive: true });
    mkdirSync(join(repo, "api", "orders"), { recursive: true });
    writeFileSync(join(repo, "web", "checkout.ts"), 'import { create } from "../api/orders/create";\nexport const buy = () => create();\n');
    writeFileSync(join(repo, "api", "orders", "create.ts"), "export const create = () => 1;\n");
    writeFileSync(join(repo, "api", "server.ts"), "export const serve = 1;\n");
    sh("git", "init", "-q");
    sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

    // the map lives in the shared git folder, never in the working tree
    const where = run("where").out.trim();
    expect(where).toBe(join(realpathSync(repo), ".git", "ondra", "code-map", "map.json"));
    expect(run("check").code).toBe(2);
    expect(run("survey").out).toContain("web → api/orders (1)");

    mkdirSync(join(where, ".."), { recursive: true });
    writeFileSync(where, JSON.stringify({
      version: 1, system: { label: "Shop" }, summary: "웹과 API",
      externals: [{ id: "stripe", label: "Stripe" }],
      containers: [{ id: "web", label: "웹", kind: "app", note: "화면" }, { id: "api", label: "API", note: "주문" }],
      components: [
        { id: "checkout", container: "web", label: "결제 화면", paths: ["web/**"], note: "결제" },
        { id: "orders", container: "api", label: "주문", paths: ["api/**", "api/orders/create.ts"], note: "주문 생성" },
        { id: "ghost", container: "api", label: "없는 것", paths: ["api/gone/**"], note: "x" },
      ],
      relations: [{ from: "checkout", to: "orders", label: "주문 생성" }, { from: "orders", to: "stripe", label: "청구" }],
    }));
    // a glob that matches nothing is an error, and nothing is stamped
    const bad = run("check", "--stamp");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('ghost: path "api/gone/**" matches no file');
    expect(bad.out).toContain("Not stamped");
    const fixed = JSON.parse(readFileSync(where, "utf8"));
    fixed.components = fixed.components.filter((c: { id: string }) => c.id !== "ghost");
    writeFileSync(where, JSON.stringify(fixed));
    const ok = run("check", "--stamp");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("3/3 (100%)");
    expect(JSON.parse(readFileSync(where, "utf8")).built.commit).toMatch(/^[0-9a-f]{40}$/);

    // after a change: the parts whose files changed, and a new file no part owns
    writeFileSync(join(repo, "api", "orders", "create.ts"), "export const create = () => 2;\n");
    mkdirSync(join(repo, "jobs"));
    writeFileSync(join(repo, "jobs", "mail.ts"), "export const mail = 1;\n");
    const drift = run("check").out;
    expect(drift).toContain("orders: api/orders/create.ts");
    expect(drift).toContain("New files no component owns: jobs/mail.ts");

    expect(run("owner", "web/checkout.ts").out).toContain("결제 화면 (checkout) in 웹");
    expect(run("owner", "web/checkout.ts").out).toContain("→ 주문: 주문 생성");

    const blocks = (args: string[]) => run("blocks", ...args).out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    // the system: containers, with relations lifted from their components
    const [sys] = blocks([]);
    expect(sys.type).toBe("arch");
    expect(sys.nodes.map((n: { id: string }) => n.id)).toEqual(["web", "api", "stripe"]);
    expect(sys.edges).toEqual([{ from: "web", to: "api", label: "주문 생성" }, { from: "api", to: "stripe", label: "청구" }]);
    // one container: its components in its zone, its neighbours around it
    const [api] = blocks(["--container", "api"]);
    expect(api.zones).toEqual([{ id: "api", label: "API" }]);
    expect(api.nodes.find((n: { id: string }) => n.id === "orders").zone).toBe("api");
    expect(api.nodes.find((n: { id: string }) => n.id === "web")).toMatchObject({ kind: "app" });
    expect(api.edges).toContainEqual({ from: "web", to: "orders", label: "주문 생성" });
  }, 30_000);

  it("reads an existing Groma map into a draft", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const repo = mkdtempSync(join(tmpdir(), "codemap-groma-"));
    const g = join(repo, "groma");
    const comp = join(g, "systems", "shop", "containers", "api", "components");
    mkdirSync(comp, { recursive: true });
    mkdirSync(join(g, "actors"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "orders.ts"), "export {};\n");
    writeFileSync(join(repo, "src", "pay.ts"), "export {};\n");
    writeFileSync(join(g, "project.md"), "---\ntype: Groma Project\ntitle: Shop\ngroma:\n  profile: architecture\n---\n\nThe shop takes orders.\n");
    writeFileSync(join(g, "systems", "shop", "system.md"), "---\ntype: C4 System\ntitle: Shop\nstatus: stable\ngroma:\n  id: shop\n---\n");
    writeFileSync(join(g, "systems", "shop", "containers", "api", "container.md"), "---\ntype: C4 Container\ntitle: API\nstatus: stable\ngroma:\n  id: api\n  parent: shop\n  technology: Hono\n---\n");
    writeFileSync(join(comp, "ordering.md"), "---\ntype: C4 Component\ntitle: Ordering\ndescription: Records orders\nstatus: stable\ngroma:\n  id: ordering\n  parent: api\n  code:\n    - scanner: typescript\n      file: src/orders.ts\n---\n\n## Relationships\n\n| Source | Target | Description | Technology |\n| --- | --- | --- | --- |\n| [orders](../../../../../../src/orders.ts) | [pay](../../../../../../src/pay.ts) | Authorizes payment | call |\n");
    writeFileSync(join(comp, "payments.md"), "---\ntype: C4 Component\ntitle: Payments\nstatus: stable\ngroma:\n  id: payments\n  parent: api\n  code:\n    - scanner: typescript\n      file: src/pay.ts\n---\n");
    writeFileSync(join(g, "actors", "customer.md"), "---\ntype: C4 Actor\ntitle: Customer\nstatus: stable\ngroma:\n  id: customer\n---\n\n## Relationships\n\n| Source | Target | Description | Technology |\n| --- | --- | --- | --- |\n| [Customer](customer.md) | [Ordering][o] | Places an order | HTTPS |\n\n[o]: ../systems/shop/containers/api/components/ordering.md\n");
    const out = execFileSync(process.execPath, [script, "from-groma", "--repo", repo], { encoding: "utf8", env: { ...process.env, CODEMAP_DIR: join(repo, "out") } });
    expect(out).toContain("1 containers, 2 components, 2 relations");
    const m = JSON.parse(readFileSync(join(repo, "out", "map.json"), "utf8"));
    expect(m.system.label).toBe("Shop");
    expect(m.components.find((c: { id: string }) => c.id === "ordering")).toMatchObject({ container: "api", note: "Records orders", paths: ["src/orders.ts"] });
    expect(m.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "ordering", to: "payments", label: "Authorizes payment" }),
      expect.objectContaining({ from: "customer", to: "ordering", label: "Places an order", tech: "HTTPS" }),
    ]));
  }, 30_000);
});
