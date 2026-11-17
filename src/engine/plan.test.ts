import { describe, expect, it } from "vitest";
import type { PlanStep } from "../state/types";
import { closePlan, moveTo, nextPlan, openAsked, planText, stepAt } from "./plan";
import { unwrapSsh, waitsOnly } from "./commandKind";

const states = (plan: PlanStep[]) => plan.map((s) => [s.state, ...(s.sub ?? []).map((x) => x.state)].join(" "));

describe("nextPlan", () => {
  it("reads big steps with their smaller ones, and plain strings as before", () => {
    const plan = nextPlan([], ["서버 확인", { text: "설문 넣기", sub: ["문항 옮기기", { text: "모달 만들기" }] }, { text: "배포", user: true }]);
    expect(plan.map((s) => s.text)).toEqual(["서버 확인", "설문 넣기", "배포"]);
    expect(plan[1].sub?.map((x) => x.text)).toEqual(["문항 옮기기", "모달 만들기"]);
    expect(plan[2].user).toBe(true);
    expect(states(plan)).toEqual(["now", "todo todo todo", "todo"]);
  });

  it("keeps finished steps, big and small, and who asked for a step, across a new plan", () => {
    const old: PlanStep[] = [
      { text: "포스트호그 지표 넣기", state: "done" },
      { text: "설문 넣기", state: "now", user: true, sub: [{ text: "문항 옮기기", state: "done" }, { text: "모달 만들기", state: "now" }] },
      { text: "배포", state: "todo" },
    ];
    // the user asked for mmhs.app while the survey was being built: it goes before the deploy, not now
    const plan = nextPlan(old, [
      "포스트호그 지표 넣기",
      { text: "설문 넣기", sub: ["문항 옮기기", "모달 만들기", "앱에 연결"] },
      { text: "mmhs.app으로 배포", user: true, sub: ["mmhs deploy 방식 확인", "올리기"] },
    ]);
    expect(states(plan)).toEqual(["done", "now done now todo", "todo todo todo"]);
    expect(plan[1].user).toBe(true);
    expect(plan[2].user).toBe(true);
  });

  it("marks a big step done once all its smaller steps are", () => {
    const old: PlanStep[] = [{ text: "A", state: "now", sub: [{ text: "a1", state: "done" }, { text: "a2", state: "done" }] }];
    const plan = nextPlan(old, [{ text: "A", sub: ["a1", "a2"] }, "B"]);
    expect(states(plan)).toEqual(["done done done", "now"]);
  });

  it("caps the list", () => {
    expect(nextPlan([], Array.from({ length: 14 }, (_, i) => `s${i}`))).toHaveLength(10);
    expect(nextPlan([], [{ text: "A", sub: Array.from({ length: 12 }, (_, i) => `a${i}`) }])[0].sub).toHaveLength(8);
    expect(nextPlan([], ["", null, 3, { sub: ["x"] }])).toEqual([]);
  });
});

describe("moveTo", () => {
  const plan = () => nextPlan([], ["A", { text: "B", sub: ["b0", "b1", "b2"] }, { text: "C", sub: ["c0"] }]);

  it("reads a step as a number, a pair or a dotted string", () => {
    expect(stepAt(1)).toEqual([1, undefined]);
    expect(stepAt([1, 2])).toEqual([1, 2]);
    expect(stepAt("1.2")).toEqual([1, 2]);
    expect(stepAt("x")).toBeUndefined();
    expect(stepAt(-1)).toBeUndefined();
  });

  it("moves inside a split step", () => {
    const p = plan();
    expect(moveTo(p, [1, 2])).toBe(true);
    expect(states(p)).toEqual(["done", "now done done now", "todo todo"]);
  });

  it("named without a smaller step, keeps the smaller ones it finished", () => {
    const p = plan();
    moveTo(p, [1, 1]);
    moveTo(p, 1);
    expect(states(p)).toEqual(["done", "now done now todo", "todo todo"]);
  });

  it("past a split step: its smaller steps are done too", () => {
    const p = plan();
    moveTo(p, 2);
    expect(states(p)).toEqual(["done", "done done done done", "now now"]);
  });

  it("a step past the end is the last one", () => {
    const p = plan();
    moveTo(p, 9);
    expect(p[2].state).toBe("now");
  });
});

describe("closePlan and openAsked", () => {
  it("closes smaller steps like big ones", () => {
    const p = nextPlan([], [{ text: "A", sub: ["a0", "a1"] }, "B"]);
    expect(states(closePlan(p))).toEqual(["done done skip", "skip"]);
  });

  it("lists what the user asked for that the job never reached", () => {
    const p: PlanStep[] = [
      { text: "설문 넣기", state: "done", user: true },
      { text: "배포", state: "now", sub: [{ text: "mmhs 방식 확인", state: "done", user: true }, { text: "백엔드도 mmhs로", state: "todo", user: true }] },
      { text: "대시보드", state: "todo", user: true },
      { text: "웹에서 확인", state: "todo" },
    ];
    expect(openAsked(p)).toEqual(["배포 › 백엔드도 mmhs로", "대시보드"]);
  });
});

describe("planText", () => {
  it("indents smaller steps and says which the user asked for", () => {
    const p = nextPlan([], ["A", { text: "B", user: true, sub: ["b0"] }]);
    expect(planText(p)).toEqual(["[>] A", "[ ] B (user asked)", "    [ ] b0"]);
  });
});

describe("waitsOnly", () => {
  it("sees waits and looks, here and over ssh", () => {
    for (const c of [
      `ssh -n ubuntu-125-186-161-87 'pgrep -f "docker build" || echo done'`,
      `for i in $(seq 1 60); do ssh -n host 'pgrep -f "docker build"' >/dev/null || break; sleep 10; done; ssh host 'tail -5 /tmp/build.log'`,
      "sleep 300",
      "gh run watch 42159843976",
      "for i in $(seq 1 30); do gh run view 1 --json status | jq -r .status; sleep 20; done",
      `ssh -n ubuntu-125-186-161-87 'kubectl get cm,secret -A 2>/dev/null | grep -i mmhs'`,
      "docker logs -f web",
    ])
      expect(waitsOnly(c), c).toBe(true);
  });

  it("never real work, here or over ssh", () => {
    for (const c of [
      "pnpm build",
      `ssh -n host 'cd app && docker build -t web .'`,
      "ssh host 'kubectl apply -f deploy.yaml'",
      "docker compose up -d --build",
      "curl -sL -o app.zip https://example.com/app.zip",
      "curl -X POST https://example.com/hook",
      "pnpm test",
    ])
      expect(waitsOnly(c), c).toBe(false);
  });

  it("unwraps the quoted remote command", () => {
    expect(unwrapSsh(`ssh -n h 'pgrep -f "docker build"'`)).toBe(`pgrep -f "docker build"`);
    expect(unwrapSsh(`x; ssh -p 22 h "tail -f log"`)).toBe("x; tail -f log");
  });
});
