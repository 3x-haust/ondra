import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state } from "../state/store";
import type { AgentSettings, CaptainMessage } from "../state/types";
import { askedLately, maybeScout, offerNote, readScout, scoutPrompt } from "./agentScout";

const NOW = new Date(2026, 10, 20, 12).getTime();
const DAY = 86_400_000;
const ask = (i: number, text: string, channel = "c1"): CaptainMessage => ({ id: `u${i}`, at: NOW - (5 - i) * DAY - 3 * 3_600_000, space: "home", project: "@agent", from: "me", text, discord: { channel, message: `m${i}` } });
const FOUND = '{"key":"아침 PR 정리","say":"요즘 아침마다 PR 정리 시키던데 매일 9시에 알아서 해둘까?","title":"아침 PR 정리","task":"열린 PR 정리해서 알려주기","when":{"kind":"daily","time":"09:00"}}';

describe("offering a routine for what the user keeps asking", () => {
  let a: AgentSettings;
  const run = (answer: string, over: Partial<Parameters<typeof maybeScout>[0]> = {}) => {
    const said: [string, string][] = [];
    const asked: string[] = [];
    return maybeScout({
      a, space: "home", voice: "반말로 툭툭", now: NOW,
      ask: async (p) => (asked.push(p), answer),
      say: async (c, t) => void said.push([c, t]),
      set: (patch) => (a = { ...a, ...patch }),
      ...over,
    }).then((made) => ({ made, said, asked }));
  };
  beforeEach(() => {
    setState(reconcile(freshState()));
    a = { on: true, name: "메타몽", ownerId: "1" };
  });

  it("with fewer than three requests it doesn't even look", async () => {
    setState("captain", [ask(1, "PR 정리해줘"), ask(2, "PR 정리해줘")]);
    const r = await run(FOUND);
    expect(r.asked).toHaveLength(0);
    expect(r.made).toBe(false);
    expect(a.scoutAt).toBe(NOW);
  });

  it("offers once, in that channel, in its voice; the same pattern is never offered again", async () => {
    setState("captain", [ask(1, "PR 정리해줘"), ask(2, "오늘 PR 정리 좀"), ask(3, "PR 정리해줘", "c7"), { id: "main", at: NOW - DAY, space: "home", from: "me", text: "main words" }]);
    const r = await run(FOUND);
    expect(r.made).toBe(true);
    expect(r.said).toEqual([["c7", "요즘 아침마다 PR 정리 시키던데 매일 9시에 알아서 해둘까?"]]);
    expect(r.asked[0]).toContain("PR 정리해줘");
    expect(r.asked[0]).not.toContain("main words");
    expect(r.asked[0]).toContain("반말로 툭툭");
    expect(a.suggested).toEqual(["아침 PR 정리"]);
    expect(a.offer).toMatchObject({ channel: "c7", task: "열린 PR 정리해서 알려주기" });
    // the agent's tab shows it said it
    expect(state.captain.some((m) => m.project === "@agent" && m.reply === r.said[0][1])).toBe(true);
    // a day later, the offer settled: the same thing isn't offered again
    a = { ...a, offer: undefined };
    const again = await run(FOUND, { now: NOW + 2 * DAY });
    expect(again.said).toHaveLength(0);
  });

  it("once a day at most, and not while an offer waits", async () => {
    setState("captain", [ask(1, "a"), ask(2, "b"), ask(3, "c")]);
    a = { ...a, scoutAt: NOW - 3_600_000 };
    expect((await run(FOUND)).asked).toHaveLength(0);
    a = { ...a, scoutAt: NOW - 2 * DAY, offer: { channel: "c1", at: NOW - 3_600_000, say: "x", title: "x", task: "x", when: {} } };
    expect((await run(FOUND)).asked).toHaveLength(0);
  });

  it("'none' or a broken answer offers nothing", async () => {
    setState("captain", [ask(1, "a"), ask(2, "b"), ask(3, "c")]);
    expect((await run("none")).made).toBe(false);
    expect(readScout('{"key":"x"}')).toBeUndefined();
    expect(readScout(`좋아요 ${FOUND}`)?.key).toBe("아침 PR 정리");
  });

  it("the user's next words there carry the offer, so a yes makes the routine", () => {
    const offer = { channel: "c7", at: NOW, say: "매일 9시에 해둘까?", title: "아침 PR 정리", task: "PR 정리", when: { kind: "daily", time: "09:00" } };
    const n = offerNote({ ...a, offer }, "c7", NOW + 60_000);
    expect(n).toContain("매일 9시에 해둘까?");
    expect(n).toContain('"time":"09:00"');
    expect(offerNote({ ...a, offer }, "other", NOW)).toBe("");
    expect(offerNote({ ...a, offer }, "c7", NOW + 4 * DAY)).toBe("");
  });

  it("looks only at the last two weeks of its own chat", () => {
    setState("captain", [{ ...ask(1, "old"), at: NOW - 20 * DAY }, ask(2, "new")]);
    expect(askedLately("home", NOW).map((x) => x.text)).toEqual(["new"]);
    expect(scoutPrompt(a, askedLately("home", NOW), [], "v")).toContain("none");
  });
});
