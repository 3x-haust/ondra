import { describe, expect, it } from "vitest";
import type { Memory } from "../state/types";
import { recall, siteWords } from "./memory";

let n = 0;
const piece = (text: string): Memory => ({ id: `m${++n}`, text, scope: "space", space: "work", createdAt: Date.now(), uses: 0 } as Memory);

describe("recall", () => {
  const pool = [
    piece("버들 본 앱은 acme-web(Next.js·Supabase)이에요."),
    piece("버들 웹 분석은 대시보드 탭을 열고 쿼리를 보내요."),
    piece("acme-web PR은 develop으로 열고 main으로는 열지 않아요."),
    piece("폰 엔진 토큰 절약은 결과 비우기 기준을 20만 자로 둬요."),
    piece("2026년 11월 배포는 팀장 확인을 받아요."),
    ...Array.from({ length: 40 }, (_, i) => piece(`초롱 앱 규칙 ${i}: 심사 전에 시뮬레이터로 확인해요.`)),
    ...Array.from({ length: 30 }, (_, i) => piece(`repo-${i} PR은 dev로 올려요.`)),
  ];

  it("finds the product's pieces from how the user names it, not from dates in the message", () => {
    const got = recall(pool, "[2026. 11. 6. 오후 12:19] 디자인팀: 하단 안내 문구 2026-0001호로 바뀌었어요 이거 버들 웹 에 적용해야하거든? pr 만 올려봐", { max: 3, budget: 600 });

    expect(got.map((m) => m.text)).toEqual(expect.arrayContaining([pool[0].text, pool[1].text]));
    expect(got.map((m) => m.text)).not.toContain(pool[3].text);
    expect(got.map((m) => m.text)).not.toContain(pool[4].text);
  });
});

describe("numbers in recall", () => {
  it("keeps short numbers that are the subject, drops times and dates", async () => {
    const { tokens } = await import("./memory");
    expect(tokens("PR 64 리뷰, 404 에러, node 18")).toEqual(expect.arrayContaining(["64", "404", "18"]));
    expect(tokens("[2026. 11. 6. 오후 12:19] 배포")).not.toEqual(expect.arrayContaining(["12", "19", "2026", "11"]));
  });
});

describe("siteWords", () => {
  it("names the sites a task links to the way memory does", () => {
    expect(siteWords("요구사항: https://www.notion.so/acme/abc 보고 만들어줘")).toEqual(["notion"]);
    expect(siteWords("https://play.google.com/console/u/0 and https://github.com/x/y")).toEqual(["google", "github"]);
    expect(siteWords("http://localhost:3000 끝")).toEqual([]);
  });
});

describe("recall without repeats", () => {
  it("gives one slot to a fact saved twice", () => {
    const pool = [piece("Pebble 릴리스는 PR 병합 후 main에서 빌드"), { ...piece("Pebble 릴리스는 PR 병합 후 main에서 빌드."), scope: "project" } as Memory, piece("Pebble 서명은 팀 계정으로 해요"), ...Array.from({ length: 20 }, (_, i) => piece(`다른 규칙 ${i}: 테스트를 먼저 돌려요.`))];
    const out = recall(pool, "Pebble 릴리스 빌드");
    expect(out.filter((x) => x.text.startsWith("Pebble 릴리스는")).length).toBe(1);
  });
});
