import { describe, expect, it } from "vitest";
import { setState } from "../state/store";
import type { CaptainMessage } from "../state/types";
import { requestsOf } from "./captain";

const m = (x: Partial<CaptainMessage> & { id: string }): CaptainMessage => ({ at: 0, space: "work", project: "p1", from: "captain", ...x }) as CaptainMessage;
describe("requestsOf", () => {
  it("keeps an earlier handed-down request's jobs and results apart from a later one", () => {
    setState("captain", [
      m({ id: "a", from: "me", via: "main", text: "심사 고쳐서 배포해줘" }),
      m({ id: "a1", relay: true, routes: [{ kind: "new", taskId: "j-release" }] }),
      m({ id: "b", from: "me", via: "main", text: "ci 실패한 것 같은데" }),
      m({ id: "b1", relay: true, routes: [{ kind: "new", taskId: "j-ci" }] }),
      // the CI job ends first, then the release job; the release job's follow-up job stays with its request
      m({ id: "b2", after: "j-ci", routes: [{ kind: "answer", text: "CI 고쳤어요", blocks: [] }] }),
      m({ id: "a2", after: "j-release", routes: [{ kind: "answer", text: "1.14.0 냈어요", blocks: [] }, { kind: "new", taskId: "j-release-2" }] }),
      m({ id: "a3", after: "j-release-2", routes: [{ kind: "answer", text: "안드로이드도 냈어요", blocks: [] }] }),
    ]);
    const [a, b] = requestsOf("work~p1");
    expect(a.ask.id).toBe("a");
    expect([...a.jobs]).toEqual(["j-release", "j-release-2"]);
    expect(a.msgs.map((x) => x.id)).toEqual(["a1", "a2", "a3"]);
    expect([...b.jobs]).toEqual(["j-ci"]);
    expect(b.msgs.map((x) => x.id)).toEqual(["b1", "b2"]);
  });
});
