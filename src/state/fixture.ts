// Dev only: sample data for working on the UI in a plain browser
// (http://localhost:1420/?fixture). Never used inside the app.
import type { AppState } from "./types";

const svg = (body: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" font-family="-apple-system,sans-serif">${body}</svg>`)}`;
const LOGIN = svg(`<rect width="640" height="360" fill="#f4f6f9"/><rect width="640" height="34" fill="#fff"/><circle cx="18" cy="17" r="5" fill="#e06c6c"/><circle cx="34" cy="17" r="5" fill="#e5b45a"/><circle cx="50" cy="17" r="5" fill="#5fbf7f"/><rect x="180" y="9" width="280" height="16" rx="8" fill="#eef1f4"/><text x="320" y="21" font-size="10" text-anchor="middle" fill="#8a94a3">localhost:5173/dashboard</text><rect x="0" y="34" width="150" height="326" fill="#fff"/><rect x="18" y="58" width="90" height="10" rx="5" fill="#2a7bc0"/><rect x="18" y="84" width="110" height="8" rx="4" fill="#dfe3e8"/><rect x="18" y="104" width="96" height="8" rx="4" fill="#dfe3e8"/><rect x="18" y="124" width="104" height="8" rx="4" fill="#dfe3e8"/><text x="176" y="72" font-size="18" font-weight="600" fill="#1b2129">대시보드</text><text x="176" y="92" font-size="11" fill="#8590a0">다시 오셨네요, 로그인 상태가 유지됐어요</text><rect x="176" y="110" width="140" height="80" rx="10" fill="#fff"/><rect x="330" y="110" width="140" height="80" rx="10" fill="#fff"/><rect x="484" y="110" width="140" height="80" rx="10" fill="#fff"/><rect x="190" y="126" width="60" height="8" rx="4" fill="#dfe3e8"/><text x="190" y="170" font-size="22" font-weight="700" fill="#1b2129">128</text><rect x="344" y="126" width="60" height="8" rx="4" fill="#dfe3e8"/><text x="344" y="170" font-size="22" font-weight="700" fill="#1b2129">94%</text><rect x="498" y="126" width="60" height="8" rx="4" fill="#dfe3e8"/><text x="498" y="170" font-size="22" font-weight="700" fill="#2a7bc0">+12</text><rect x="176" y="206" width="448" height="136" rx="10" fill="#fff"/><polyline points="196,320 250,290 300,300 360,250 420,262 480,220 540,232 604,196" fill="none" stroke="#2a7bc0" stroke-width="3"/>`);
const PRICING = svg(`<rect width="640" height="360" fill="#fff"/><rect width="640" height="34" fill="#f2f3f5"/><rect x="180" y="9" width="280" height="16" rx="8" fill="#fff"/><text x="320" y="21" font-size="10" text-anchor="middle" fill="#8a94a3">acme.dev/pricing</text><text x="320" y="84" font-size="22" font-weight="700" text-anchor="middle" fill="#1b2129">요금제</text><g><rect x="70" y="112" width="150" height="210" rx="12" fill="#f6f7f9"/><rect x="245" y="104" width="150" height="226" rx="12" fill="#1b2129"/><rect x="420" y="112" width="150" height="210" rx="12" fill="#f6f7f9"/></g><text x="145" y="150" font-size="13" text-anchor="middle" fill="#4d5765">무료</text><text x="145" y="186" font-size="24" font-weight="700" text-anchor="middle" fill="#1b2129">₩0</text><text x="320" y="144" font-size="13" text-anchor="middle" fill="#b8c4d2">프로</text><text x="320" y="182" font-size="24" font-weight="700" text-anchor="middle" fill="#fff">₩19,000</text><rect x="268" y="282" width="104" height="30" rx="8" fill="#2a7bc0"/><text x="495" y="150" font-size="13" text-anchor="middle" fill="#4d5765">팀</text><text x="495" y="186" font-size="24" font-weight="700" text-anchor="middle" fill="#1b2129">문의</text><circle cx="320" cy="297" r="16" fill="none" stroke="#e06c6c" stroke-width="3"/>`);


export function fixture(base: AppState): AppState {
  const t = Date.now();
  const m = (min: number) => t - min * 60_000;
  return {
    ...base,
    onboarded: true,
    space: "work",
    spaces: [{ id: "work", label: "회사", folder: "~", rules: "" }, ...base.spaces],
    accounts: [{ ...base.accounts[0], space: "work", label: "회사", providers: ["openai-codex"], model: "openai-codex/gpt-5.6-terra", stats: { input: 120000, output: 30000, cacheRead: 880000, cacheWrite: 40000 } }],
    tasks: [
      {
        id: "t1", space: "work", topic: "ondra", title: "로그인 리다이렉트 수정", ask: "로그인 후 대시보드로 안 가고 홈으로 튕기는 문제 고쳐 줘. 테스트까지.",
        cwd: "~/01_Project/01_Projects/ondra", status: "running", priority: 1, weight: "light", accountId: "default", createdAt: m(14), startedAt: m(13),
        now: "테스트 실행 중", plan: [{ text: "원인 찾기", state: "done" }, { text: "리다이렉트 수정", state: "done" }, { text: "테스트", state: "now" }, { text: "정리", state: "todo" }],
        legs: [
          { startedAt: m(40), endedAt: m(26), handoff: { did: ["원인 찾기"], next: "가드 수정", evidence: [] } },
          { startedAt: m(26), endedAt: m(13), handoff: { did: ["가드 고치고 커밋"], next: "테스트", evidence: [] } },
          { startedAt: m(13) },
        ],
        entries: [
          { id: "e1", at: m(14), kind: "user", text: "로그인 후 대시보드로 안 가고 홈으로 튕기는 문제 고쳐 줘. 테스트까지." },
          { id: "e2", at: m(13), kind: "text", text: "원인부터 찾을게요. 로그인 콜백과 라우터 가드를 볼게요." },
          { id: "e3", at: m(13), kind: "tool", tool: { name: "grep", kind: "search", target: "redirect", ok: true, endedAt: m(12.9) } },
          { id: "e4", at: m(12.8), kind: "tool", tool: { name: "read", kind: "read", target: "auth-callback.ts", detail: "/x/src/auth-callback.ts", ok: true, endedAt: m(12.7) } },
          { id: "e5", at: m(12.6), kind: "tool", tool: { name: "read", kind: "read", target: "router.ts", detail: "/x/src/router.ts", ok: true, endedAt: m(12.5) } },
          { id: "e6", at: m(12), kind: "text", text: "`router.ts`의 가드가 세션 복원 전에 실행되어 **비로그인으로 판단**하고 있었어요. 세션 복원을 기다리도록 바꿀게요." },
          { id: "e7", at: m(11), kind: "tool", tool: { name: "edit", kind: "edit", target: "router.ts", detail: "/x/src/router.ts", add: 8, del: 3, ok: true, endedAt: m(10.9) } },
          { id: "e8", at: m(10), kind: "block", block: { type: "files", files: [{ path: "src/router.ts", add: 8, del: 3 }, { path: "src/auth/session.ts", add: 4, del: 1 }] } },
          { id: "e8b", at: m(9.5), kind: "text", text: "수정은 끝났어요. 테스트와 다른 로그인 경로 점검은 서브에이전트 둘에게 나눠 맡길게요." },
          { id: "e8c", at: m(9.4), kind: "spawn", childIds: ["t1a", "t1b"] },
          { id: "e9", at: m(9), kind: "tool", tool: { name: "bash", kind: "test", target: "pnpm vitest run auth", detail: "pnpm vitest run auth", shellId: "s1" } },
        ],
        shells: [
          { id: "s0", command: "pnpm dev &", startedAt: m(12), tail: "VITE v8.0.16  ready in 412 ms\n➜  Local:   http://localhost:5173/", background: true },
          { id: "s1", command: "pnpm vitest run auth", startedAt: m(9), tail: " ✓ auth/session.test.ts (6)\n ✓ auth/callback.test.ts (4)\n ❯ router.guard.test.ts (3)\n   ✓ waits for session restore\n   ✓ redirects to /dashboard" },
        ],
        inbox: [],
        shot: LOGIN,
        worktree: { repo: "/Users/me/ondra", path: "/x/worktrees/ondra-t1", branch: "task/t1", base: "abc", sub: "", state: "open" },
      },
      {
        id: "t6", space: "work", topic: "ondra", title: "로고 색 바꾸기", ask: "로고 파란색으로", cwd: "~", status: "done", priority: 3, weight: "light", accountId: "default",
        createdAt: m(320), startedAt: m(319), finishedAt: m(300), now: "", summary: "로고를 바다색으로 바꿨어요", plan: [], legs: [], entries: [], shells: [], inbox: [],
        worktree: { repo: "/Users/me/ondra", path: "/x/worktrees/ondra-t6", branch: "task/t6", base: "abc", sub: "", state: "merged" },
      },
      {
        id: "t5", space: "work", topic: "acme", title: "요금제 페이지 점검", ask: "acme.dev 요금제 페이지 결제 버튼 동작 확인", cwd: "~/acme", status: "running", priority: 2, weight: "light", accountId: "default",
        createdAt: m(6), startedAt: m(6), now: "프로 요금제 결제 버튼을 누르는 중", browser: true, shot: PRICING,
        plan: [{ text: "페이지 열기", state: "done" }, { text: "버튼 확인", state: "now" }, { text: "정리", state: "todo" }], legs: [{ startedAt: m(6) }],
        entries: [
          { id: "p1", at: m(6), kind: "user", text: "acme.dev 요금제 페이지 결제 버튼 동작 확인" },
          { id: "p2", at: m(5), kind: "tool", tool: { name: "browser", kind: "browser", target: "acme.dev/pricing 열기", ok: true, endedAt: m(4.9) } },
          { id: "p3", at: m(3), kind: "tool", tool: { name: "browser", kind: "browser", target: "‘프로 시작하기’ 클릭" } },
        ],
        shells: [], inbox: [],
      },
      {
        id: "t1a", parentId: "t1", space: "work", topic: "ondra", title: "인증 테스트 돌리기", ask: "auth 관련 테스트 전부 돌리고 실패 원인 정리", cwd: "~/01_Project/01_Projects/ondra",
        status: "running", priority: 1, weight: "light", accountId: "default", createdAt: m(9.4), startedAt: m(9.3), now: "router.guard.test.ts 실행 중", plan: [], legs: [{ startedAt: m(9.3) }],
        entries: [
          { id: "h1", at: m(9.4), kind: "user", text: "auth 관련 테스트 전부 돌리고 실패 원인 정리" },
          { id: "h2", at: m(9.2), kind: "tool", tool: { name: "bash", kind: "test", target: "pnpm vitest run auth", detail: "pnpm vitest run auth", ok: true, endedAt: m(8.8) } },
          { id: "h3", at: m(8.7), kind: "text", text: "세션·콜백 테스트 10개는 통과했어요. 라우터 가드 테스트를 보고 있어요." },
        ],
        shells: [], inbox: [],
      },
      {
        id: "t1b", parentId: "t1", space: "work", topic: "ondra", title: "소셜 로그인 경로 점검", ask: "구글·깃허브 로그인 콜백도 같은 문제 있는지 확인", cwd: "~/01_Project/01_Projects/ondra",
        status: "done", priority: 1, weight: "light", accountId: "default", createdAt: m(9.4), startedAt: m(9.3), finishedAt: m(6), now: "같은 문제 없음", summary: "OAuth 콜백 두 곳 모두 세션 복원 뒤에 이동해요. 고칠 곳 없음.",
        result: "구글·깃허브 콜백 모두 세션 복원 뒤 리다이렉트. 문제 없음.", plan: [], legs: [{ startedAt: m(9.3), endedAt: m(6) }],
        entries: [
          { id: "k1", at: m(9.4), kind: "user", text: "구글·깃허브 로그인 콜백도 같은 문제 있는지 확인" },
          { id: "k2", at: m(9), kind: "tool", tool: { name: "grep", kind: "search", target: "oauth/callback", ok: true, endedAt: m(8.9) } },
          { id: "k3", at: m(8.5), kind: "tool", tool: { name: "read", kind: "read", target: "oauth.ts", detail: "/x/src/auth/oauth.ts", ok: true, endedAt: m(8.4) } },
          { id: "k4", at: m(6), kind: "text", text: "두 콜백 모두 `await restore()` 뒤에 이동해서 같은 문제는 없어요." },
        ],
        shells: [], inbox: [],
      },
      {
        id: "t_re", space: "work", topic: "ondra", title: "보안 입력 판별 분석", ask: "ondra-cuhost가 비밀번호 칸을 어떻게 알아보는지 바이너리에서 확인", cwd: "~/01_Project/01_Projects/ondra",
        status: "done", priority: 2, weight: "light", accountId: "default", createdAt: m(40), startedAt: m(40), finishedAt: m(34), now: "판별 함수 확인", summary: "role·subrole 문자열 비교로 보안 입력을 알아봐요.",
        plan: [], legs: [{ startedAt: m(40), endedAt: m(34) }],
        entries: [
          { id: "r1", at: m(40), kind: "user", text: "ondra-cuhost가 비밀번호 칸을 어떻게 알아보는지 바이너리에서 확인" },
          { id: "r2", at: m(39), kind: "tool", tool: { name: "bash", kind: "bash", target: "ondra-binary functions ondra-cuhost --name secure", detail: "ondra-binary functions ondra-cuhost --name secure", ok: true, endedAt: m(38.9) } },
          { id: "r3", at: m(38), kind: "tool", tool: { name: "bash", kind: "bash", target: "ondra-binary decompile ondra-cuhost --address 0x10000632c", detail: "ondra-binary decompile ondra-cuhost --address 0x10000632c", ok: true, endedAt: m(37.8) } },
          { id: "r4", at: m(34), kind: "text", text: "`isSecure`가 role과 subrole을 문자열로 비교해서 보안 입력을 알아봐요." },
        ],
        shells: [], inbox: [],
      },
      {
        id: "t2", space: "work", topic: "블로그", title: "4월 회고 초안", ask: "4월 회고 초안 써 줘", cwd: "~/blog", status: "waiting", priority: 2, weight: "light", accountId: "default",
        createdAt: m(15), startedAt: m(15), now: "초안 완료, 게시 확인 대기", plan: [], legs: [{ startedAt: m(39) }],
        entries: [
          { id: "f1", at: m(40), kind: "user", text: "4월 회고 초안 써 줘" },
          { id: "f2", at: m(38), kind: "tool", tool: { name: "read", kind: "read", target: "notes/2026-04.md", ok: true, endedAt: m(37) } },
          { id: "f3", at: m(36), kind: "tool", tool: { name: "write", kind: "write", target: "drafts/april-retro.md", detail: "~/blog/drafts/april-retro.md", add: 42, del: 0, ok: true, endedAt: m(35) } },
          { id: "f4", at: m(34), kind: "text", text: "초안을 썼어요.\n\n> **4월 회고 — 작게, 자주 내보내기**\n>\n> 이번 달엔 큰 기능 하나 대신 작은 개선을 열두 번 내보냈어요. 배포가 무섭지 않아지니 리뷰도 짧아졌고, 주말에 일하는 날이 사라졌어요. 다음 달엔 같은 방식으로 온보딩을 손볼 거예요.\n\n전체는 `drafts/april-retro.md`에 있어요. 바로 게시할까요?" },
        ], shells: [], inbox: [], unread: true,
      },
      {
        id: "t3", space: "work", topic: "ondra", title: "README 정리", ask: "README 정리", cwd: "~", status: "done", priority: 3, weight: "light", accountId: "default",
        createdAt: m(200), startedAt: m(199), finishedAt: m(180), now: "README 갱신 완료", summary: "설치 · 구조 섹션 정리, 오래된 내용 삭제", unverified: ["새 스크린샷은 못 찍었어요"], plan: [], legs: [{ startedAt: m(199), endedAt: m(180) }],
        entries: [
          { id: "g1", at: m(200), kind: "user", text: "README 정리해 줘. 설치 방법이랑 구조 위주로." },
          { id: "g2", at: m(198), kind: "tool", tool: { name: "read", kind: "read", target: "README.md", detail: "/x/README.md", ok: true, endedAt: m(197) } },
          { id: "g2t", at: m(197.5), kind: "text", text: "README를 읽어 보니 설치 방법이 두 군데로 나뉘어 있고, 지금은 없는 '대장' 설명이 남아 있어요. 구조부터 그림으로 정리하고 고칠게요." },
          { id: "l1", at: m(197.6), kind: "block", block: { type: "link", kind: "file", title: "확인한 포트폴리오 · 40쪽", ref: "/Users/me/Downloads/포폴.pdf" } },
          { id: "l2", at: m(197.55), kind: "block", block: { type: "link", kind: "file", title: "확인한 이력서 · 5쪽", ref: "/Users/me/Downloads/이력서.pdf" } },
          { id: "l3", at: m(197.5), kind: "block", block: { type: "link", kind: "doc", title: "상세 확인 보고서", ref: "/Users/me/Library/Application Support/dev.3xhaust.ondra/artifacts/t3/review.html" } },
          { id: "v1", at: m(197.4), kind: "block", block: { type: "scope", label: "README만 고치고 코드는 그대로예요", in: [{ label: "설치 · 구조 섹션", note: "Homebrew와 직접 빌드" }, { label: "깨진 링크 4개" }], out: [{ label: "앱 코드", note: "읽기만 해요" }, { label: "스크린샷 새로 찍기", note: "다음에" }] } },
          { id: "v2", at: m(197.3), kind: "block", block: { type: "bars", label: "사용자 데이터가 절반을 넘어요", unit: "GB", items: [{ label: "사용자 데이터", value: 494, highlight: true, note: "모델·프로젝트" }, { label: "설치 앱", value: 118 }, { label: "System · Private", value: 49 }, { label: "공용 Library", value: 33 }] } },
          { id: "v3", at: m(197.2), kind: "block", block: { type: "tree", label: "큰 덩어리는 프로젝트와 모델이에요", unit: "GB", items: [{ path: "~/01_Project/01_Projects", value: 126, note: "개발 레포" }, { path: "~/.ollama/models", value: 36, note: "로컬 모델" }, { path: "~/Music", value: 19 }, { path: "~/Library/Developer/CoreSimulator", value: 24, note: "시뮬레이터", state: "changed" }] } },
          { id: "v4", at: m(197.1), kind: "block", block: { type: "groups", label: "앱은 세 부분으로 나뉘어요", groups: [{ label: "앱 (Tauri)", note: "창 · 파일 · 프로세스", items: [{ label: "엔진 실행", ref: "/x/src-tauri/src/engine.rs:40" }, { label: "디바이스 허브", state: "new" }] }, { label: "화면 (SolidJS)", items: [{ label: "채팅" }, { label: "캔버스" }, { label: "그림 블록", state: "changed" }] }, { label: "엔진 (3xhaustPi)", note: "일마다 하나", items: [{ label: "캐시 · 압축" }, { label: "스킬" }] }], links: [{ from: "화면", to: "앱", label: "명령" }, { from: "앱", to: "엔진", label: "RPC" }] } },
          { id: "v5", at: m(197.05), kind: "block", block: { type: "sequence", label: "메시지 하나가 일이 되기까지", actors: ["나", "메인", "일", "리뷰"], steps: [{ from: "나", to: "메인", label: "요청" }, { from: "메인", to: "일", label: "따로 맡김", note: "새 브랜치" }, { from: "일", to: "리뷰", label: "리뷰 부탁" }, { from: "리뷰", to: "일", label: "P2 하나" }, { from: "일", to: "일", label: "고치고 테스트" }, { from: "일", to: "나", label: "증거와 함께 끝" }] } },
          { id: "v6", at: m(197.02), kind: "block", block: { type: "steps", label: "남은 건 확인 하나예요", items: [{ label: "읽기", state: "done" }, { label: "다시 쓰기", note: "설치 · 구조", state: "done" }, { label: "링크 확인", state: "now" }, { label: "스크린샷", state: "todo" }] } },
          { id: "g2d", at: m(197), kind: "block", block: { type: "diagram", label: "README가 설명하는 구조", nodes: [{ id: "app", label: "앱 (Tauri)", note: "창 · 파일 · 프로세스", ref: "/x/src-tauri/src/lib.rs:12" }, { id: "ui", label: "화면 (SolidJS)", note: "채팅 · 캔버스", ref: "/x/src/App.tsx:1" }, { id: "engine", label: "엔진 (3xhaustPi)", note: "일마다 하나씩 실행" }, { id: "install", label: "설치 섹션", note: "Homebrew · 직접 빌드", state: "new", by: "user" }, { id: "old", label: "대장 설명", state: "gone", by: "agent" }], edges: [{ from: "app", to: "ui" }, { from: "app", to: "engine", label: "RPC" }, { from: "ui", to: "install" }, { from: "engine", to: "old" }] } },
          { id: "g3", at: m(196), kind: "tool", tool: { name: "edit", kind: "edit", target: "README.md", detail: "/x/README.md", add: 6, del: 9, ok: true, endedAt: m(195) } },
          { id: "g4", at: m(194), kind: "tool", tool: { name: "edit", kind: "edit", target: "docs/setup.md", detail: "/x/docs/setup.md", add: 3, del: 1, ok: true, endedAt: m(193) } },
          { id: "g4t", at: m(193), kind: "text", text: "설치 섹션을 Homebrew와 직접 빌드 두 가지로 나눴어요. 이제 설치 명령을 실제로 돌려 보고 링크가 다 열리는지 확인할게요." },
          { id: "g4b", at: m(192.8), kind: "tool", tool: { name: "bash", kind: "bash", target: "brew install --build-from-source ./ondra.rb", detail: "brew install --build-from-source ./ondra.rb", ok: true, endedAt: m(190) } },
          { id: "g4c", at: m(189.8), kind: "tool", tool: { name: "bash", kind: "test", target: "pnpm lint:links", detail: "pnpm lint:links", ok: true, endedAt: m(189) } },
          { id: "g4u", at: m(188.5), kind: "text", text: "설치는 한 번에 끝났고 링크 18개가 모두 열려요. 다음 사람이 이어서 볼 수 있게 지금 상태를 기록해 둘게요." },
          { id: "g4n", at: m(192), kind: "tool", tool: { name: "edit", kind: "edit", note: true, text: "## README 정리\n- 설치: Homebrew · 직접 빌드 두 가지\n- 다음: 스크린샷 새로 찍기", target: "now.md", detail: "/x/context/now.md", add: 3, del: 0, ok: true, endedAt: m(192) } },
          { id: "g5", at: m(181), kind: "text", text: "설치와 구조 섹션을 새로 쓰고, 지금은 없는 기능 설명을 지웠어요. 설치는 Homebrew와 직접 빌드 두 가지로 나눠 적었고, 구조는 앱(Tauri) · 화면(SolidJS) · 엔진(3xhaustPi) 세 부분으로 그림과 함께 설명했어요. 오래된 '대장' 설명, 없어진 단축키 표, 깨진 링크 4개를 지웠어요. 문장은 짧게 바꿔서 전체 길이가 절반쯤으로 줄었어요." },
          { id: "g5a", at: m(181), kind: "block", block: { type: "timeline", label: "한 일", items: [{ label: "지금 README 읽기", at: "2분", state: "done" }, { label: "설치 · 구조 다시 쓰기", at: "9분", state: "done" }, { label: "오래된 내용 지우기", at: "4분", state: "done" }, { label: "링크 확인", at: "3분", state: "done" }] } },
          { id: "g5b", at: m(181), kind: "block", block: { type: "compare", label: "설치 단계", before: 4, after: 2, better: "down" } },
          { id: "g5c", at: m(181), kind: "block", block: { type: "checklist", label: "확인", items: [{ label: "설치 명령 실제로 실행", done: true }, { label: "링크 18개 열림", done: true }, { label: "스크린샷 새로 찍기", done: false }] } },
          { id: "g5e", at: m(180), kind: "block", block: { type: "evidence", items: [{ kind: "run", ref: "brew install --build-from-source ./ondra.rb", ok: true }, { kind: "test", ref: "pnpm lint:links", ok: true, note: "링크 18개 열림" }, { kind: "file", ref: "/x/README.md", ok: true }], unverified: ["새 스크린샷은 못 찍었어요"] } },
          { id: "g6", at: m(180), kind: "turn", ms: 19 * 60_000, usage: { input: 640, cacheRead: 41_300, cacheWrite: 0, output: 5_820, ms: 19 * 60_000, tps: 61.2, limits: [{ window: 300, used: 38 }, { window: 10080, used: 31 }] } },
        ],
        shells: [], inbox: [], unread: true,
        worktree: { repo: "/Users/me/ondra", path: "/x/worktrees/ondra-t3", branch: "task/t3", base: "readme", sub: "", state: "open" },
      },
      {
        id: "t7", space: "work", topic: "ondra", title: "로그인 후 이동 고치기", ask: "로그인하면 대시보드로 가게 고쳐 줘", cwd: "~/01_Project/01_Projects/ondra", status: "done", priority: 3, weight: "light", accountId: "default",
        createdAt: m(90), startedAt: m(89), finishedAt: m(70), now: "", summary: "로그인 뒤 대시보드로 이동", unverified: ["Safari에서는 못 봤어요", "소셜 로그인 경로는 안 봤어요"], plan: [], legs: [{ startedAt: m(89), endedAt: m(70) }],
        entries: [
          { id: "w1", at: m(90), kind: "user", text: "로그인하면 대시보드로 가게 고쳐 줘" },
          { id: "w2", at: m(88), kind: "tool", tool: { name: "read", kind: "read", target: "router.ts", detail: "/Users/me/ondra/src/router.ts", ok: true, endedAt: m(87.9) } },
          { id: "w3", at: m(86), kind: "tool", tool: { name: "edit", kind: "edit", target: "router.ts", detail: "/Users/me/ondra/src/router.ts", add: 8, del: 3, ok: true, endedAt: m(85.9) } },
          { id: "w4", at: m(84), kind: "tool", tool: { name: "edit", kind: "edit", target: "session.ts", detail: "/Users/me/ondra/src/auth/session.ts", add: 4, del: 1, ok: true, endedAt: m(83.9) } },
          { id: "w5", at: m(80), kind: "tool", tool: { name: "bash", kind: "test", target: "pnpm vitest run auth", detail: "pnpm vitest run auth", ok: true, endedAt: m(79) } },
          { id: "w6", at: m(78), kind: "tool", tool: { name: "bash", kind: "bash", target: "pnpm build", detail: "pnpm build", ok: true, endedAt: m(77) } },
          { id: "w7", at: m(75), kind: "tool", tool: { name: "browser", kind: "browser", target: "localhost:5173/login 열기", ok: true, endedAt: m(74.9) } },
          { id: "w8", at: m(71), kind: "text", text: "라우터 가드가 세션 복원을 기다리도록 바꿔서, 로그인하면 바로 대시보드로 가요. 인증 테스트 12개가 모두 통과했고, 빌드도 됐어요. 브라우저에서 로그인해 대시보드가 뜨는 것까지 찍어 뒀어요." },
          { id: "w9", at: m(70), kind: "block", block: { type: "evidence", items: [
            { kind: "test", ref: "pnpm vitest run auth", ok: true, check: "ran", out: "Tests 12 passed (12)" },
            { kind: "build", ref: "pnpm build", ok: true, check: "ran", out: "✓ built in 2.41s" },
            { kind: "run", ref: "pnpm lint", ok: false, check: "stale", why: "돌린 뒤에 코드가 바뀌었어요" },
            { kind: "shot", ref: LOGIN, ok: true, check: "exists", note: "로그인 뒤 대시보드" },
            { kind: "shot", ref: PRICING, ok: true, check: "exists", note: "로그아웃 상태" },
            { kind: "file", ref: "/Users/me/ondra/src/router.ts", ok: true, check: "exists" },
            { kind: "link", ref: "https://localhost:5173/dashboard", ok: true, check: "read", note: "대시보드 열림" },
            { kind: "note", ref: "기존 세션은 그대로 유지돼요", ok: true, check: "self" },
          ], unverified: ["Safari에서는 못 봤어요", "Safari에서는 못 봤어요.", "소셜 로그인 경로는 안 봤어요"] } },
          { id: "w10", at: m(70), kind: "turn", ms: 19 * 60_000 },
        ],
        shells: [], inbox: [],
        worktree: { repo: "/Users/me/ondra", path: "/Users/me/ondra-wt/t7", branch: "task/t7", base: "abc", sub: "", state: "open" },
      },
      {
        id: "t4", space: "work", topic: "앱", title: "iOS 시뮬레이터 스크린샷", ask: "x", cwd: "~", status: "queued", priority: 0, weight: "heavy", accountId: "default",
        createdAt: m(2), now: "대기 중", plan: [], legs: [], entries: [], shells: [], inbox: [],
      },
    ],
    decisions: [
      { id: "d1", taskId: "t2", at: m(5), kind: "ask", question: "초안을 블로그에 바로 게시할까요?", options: [{ id: "a", label: "게시", primary: true }, { id: "b", label: "초안으로 저장" }, { id: "c", label: "수정 후 다시" }], context: [] },
    ],
    projects: [
      { id: "ondra", space: "work", name: "ondra", folder: "~/01_Project/01_Projects/ondra" },
      { id: "acme", space: "work", name: "acme", folder: "~/acme" },
      { id: "blog", space: "work", name: "blog", folder: "~/blog" },
    ],
    captain: [
      { id: "cr", at: m(201), space: "work", from: "me", text: "README 좀 정리해 줘. 오래된 내용 빼고" },
      { id: "crr", at: m(201), space: "work", from: "captain", reply: "바로 정리할게요.", routes: [{ kind: "new", taskId: "t3" }] },
      { id: "c0", at: m(16), space: "work", from: "me", text: "하이" },
      { id: "c0r", at: m(16), space: "work", from: "captain", reply: "안녕하세요! 오늘은 뭘 같이 해 볼까요?", routes: [] },
      { id: "c1", at: m(15), space: "work", from: "me", text: "로그인 튕기는 거 고쳐 줘. 그리고 4월 회고 초안도. 아 블로그는 항상 반말로 써" },
      { id: "c2", at: m(15), space: "work", from: "captain", reply: "두 가지로 나눠서 바로 시작할게요. 블로그 말투도 기억해 둘게요.", routes: [{ kind: "new", taskId: "t1" }, { kind: "new", taskId: "t2" }, { kind: "remember", memoryId: "m1" }] },
      { id: "c5", at: m(7), space: "work", from: "me", text: "acme 요금제 페이지 결제 버튼 되는지 봐 줘. 그리고 iOS 시뮬레이터 스크린샷도 새로" },
      { id: "c5r", at: m(7), space: "work", from: "captain", reply: "둘 다 따로 맡겼어요. 스크린샷은 시뮬레이터가 비면 시작해요.", routes: [{ kind: "new", taskId: "t5" }, { kind: "new", taskId: "t4" }], usage: { input: 120, cacheRead: 11_400, cacheWrite: 0, output: 310, ms: 6_400, tps: 48.4, limits: [{ window: 300, used: 38 }, { window: 10080, used: 31 }] } },
      { id: "c2b", at: m(4), space: "work", from: "me", text: "지금 몇 개 돌아가?" },
      { id: "c2c", at: m(4), space: "work", from: "captain", reply: "", routes: [{ kind: "answer", text: "**2개**가 돌고 있고, 1개는 곧 시작해요. 할 일은 **2개**예요.\n\n- 로그인 리다이렉트 수정: 테스트 중이고, 서브에이전트 2개 중 1개가 끝났어요\n- 요금제 페이지 점검: 결제 버튼을 누르는 중이에요\n- iOS 시뮬레이터 스크린샷: 곧 시작해요\n- 할 일: 4월 회고 초안은 게시할지 답을, README 정리는 확인을 기다려요", blocks: [] }] },
      { id: "c3", at: m(1), space: "work", from: "me", text: "다음 주 배포 일정 정리해 줘" },
      { id: "c4", at: m(1), space: "work", from: "captain", reply: "", routes: [{ kind: "answer", text: "다음 주는 **화요일 오전**에 스테이징, **목요일 오후**에 운영 배포예요. 로그인 수정이 합쳐져야 목요일에 같이 나가요.", blocks: [] }] },
    ],
    results: [
      { id: "r_logo", taskId: "t6", space: "work", project: "ondra", title: "로고 색 바꾸기", reply: "로고를 파란색으로 바꿨어요.", answers: [{ text: "앱 아이콘과 메뉴 막대 아이콘 둘 다 **#2F6BFF**로 맞췄어요. 어두운 화면에서도 대비가 4.8:1이라 잘 보여요.", blocks: [] }], at: m(300) },
      { id: "r_readme", taskId: "t3", space: "work", project: "ondra", title: "README 정리", reply: "README에서 오래된 설치 안내를 빼고 지금 쓰는 방법만 남겼어요.", answers: [{ text: "- 설치: DMG 하나로 끝나요\n- 빠진 것: 예전 CLI 설치, 베타 신청 링크\n- 새로 쓴 것: 업데이트 방법", blocks: [{ type: "files", files: [{ path: "README.md", add: 12, del: 10 }] }] }], at: m(190) },
      { id: "r_re", taskId: "t_re", space: "work", project: "ondra", title: "보안 입력 판별 분석", reply: "", answers: [{ text: "ondra-cuhost는 접근성 요소의 **role**과 **subrole**을 문자열로 비교해서 비밀번호 칸을 알아봐요. `AXSecureTextField`면 입력을 막아요.", blocks: [{ type: "metric", label: "읽은 함수", value: "549" }] }], at: m(34) },
      { id: "r_price", taskId: "t1a", space: "work", project: "acme", title: "요금제 표 문구 점검", reply: "요금제 표에서 틀린 가격 두 곳을 찾았어요.", answers: [{ text: "프로 요금제 연간 가격이 표와 결제 화면에서 달라요. 표를 결제 화면 값으로 맞추면 돼요.", blocks: [] }], at: m(1500), pinned: true },
    ],
    memory: [{ id: "m1", text: "블로그 글은 반말로 쓴다", scope: "space", space: "work", source: "ondra", createdAt: m(15), uses: 2 }],
  };
}
