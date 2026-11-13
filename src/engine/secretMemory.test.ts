import { beforeEach, describe, expect, it } from "vitest";
import { setState, state } from "../state/store";
import { forgetSecret, noteSecrets, pieceKey, secretPiece, serviceOf } from "./secretMemory";
import { retireMemory } from "./memory";

const projects = [{ id: "p1", name: "Deploy", folder: "/Users/me/Deploy", space: "work" }];

describe("secret memory", () => {
  beforeEach(() => setState("memory", []));

  it("says where a secret is and guesses its service, never a value", () => {
    expect(serviceOf("NEXT_PUBLIC_SUPABASE_ANON_KEY")).toBe("Supabase");
    expect(serviceOf("MY_THING")).toBeUndefined();
    const p = secretPiece("VERCEL_TOKEN", { project: "Deploy", dir: "Deploy/Front" });
    expect(p.text).toContain("`VERCEL_TOKEN`: Deploy 프로젝트 Deploy/Front/.env의 시크릿이에요.");
    expect(p.text).toContain("Vercel 키로 보여요.");
    expect(p.about).toEqual(["시크릿", "Vercel"]);
    expect(secretPiece("NEXT_PUBLIC_KEY", {}).text).toContain("브라우저에 그대로 드러나요");
  });

  it("gives each saved secret one piece in its project, once", () => {
    const saved = { global: ["OPENAI_API_KEY"], projects: { p1: ["STRIPE_KEY", "Deploy/Front:VERCEL_TOKEN"], gone: ["X_KEY"] } };
    expect(noteSecrets(saved, projects)).toBe(3);
    const stripe = state.memory.find((m) => m.key === pieceKey("p1", "STRIPE_KEY"))!;
    expect(stripe).toMatchObject({ scope: "project", project: "/Users/me/Deploy", space: "work", kind: "fact", by: "agent" });
    expect(state.memory.find((m) => m.key === pieceKey(undefined, "OPENAI_API_KEY"))?.scope).toBe("global");
    // opening the page again adds nothing; a piece a job replaced isn't made again
    retireMemory(stripe.id, "m-better");
    expect(noteSecrets(saved, projects)).toBe(0);
  });

  it("drops a deleted secret's piece and retires what replaced it", () => {
    noteSecrets({ global: [], projects: { p1: ["STRIPE_KEY"] } }, projects);
    const first = state.memory[0];
    setState("memory", (l) => [...l, { ...first, id: "m-better", key: undefined, text: "`STRIPE_KEY`: 테스트 결제 키" }]);
    retireMemory(first.id, "m-better");
    forgetSecret("p1", "STRIPE_KEY");
    expect(state.memory.map((m) => m.id)).toEqual(["m-better"]);
    expect(state.memory[0].invalidAt).toBeTruthy();
  });
});
