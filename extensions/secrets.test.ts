import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import secrets, { dotenvSecrets, envFilesUnder, envSecrets, maskSecrets, namesUsed, promptNote, redact, secretDirs, variants } from "./secrets";

const KEY = "sk_live_51Habc123XYZ";

describe("secrets", () => {
  it("hides a value and its encoded forms", () => {
    const s = [{ name: "STRIPE_KEY", value: KEY }];
    const b64 = Buffer.from(KEY).toString("base64");
    const r = redact(`key=${KEY}\nb64=${b64}\nurl=${encodeURIComponent(KEY)}\nhex=${Buffer.from(KEY).toString("hex")}`, s);
    expect(r.text).not.toContain(KEY);
    expect(r.text).not.toContain(b64);
    expect(r.text.match(/\[secret:STRIPE_KEY\]/g)?.length).toBe(4);
    expect(r.hits).toEqual(["STRIPE_KEY"]);
  });

  it("hides the longer of two overlapping values whole", () => {
    const r = redact("abcdef123456", [
      { name: "SHORT", value: "abcdef" },
      { name: "LONG", value: "abcdef123456" },
    ]);
    expect(r.text).toBe("[secret:LONG]");
  });

  it("leaves short values and plain text alone", () => {
    expect(variants("dev")).toEqual([]);
    expect(redact("nothing here", [{ name: "A", value: "zzzzzzzz" }])).toEqual({ text: "nothing here", hits: [] });
  });

  it("takes only secret-looking keys from .env", () => {
    const got = dotenvSecrets(
      ['API_KEY="abc123456"', "export DB_PASSWORD=hunter22 # old", "NODE_ENV=production", "PORT=3000", "GITHUB_TOKEN='ghp_x1y2z3'", "# SECRET=commented"].join("\n"),
      ".env",
    );
    expect(got).toEqual([
      { name: ".env:API_KEY", value: "abc123456" },
      { name: ".env:DB_PASSWORD", value: "hunter22" },
      { name: ".env:GITHUB_TOKEN", value: "ghp_x1y2z3" },
    ]);
  });

  it("reads the names Ondra set, with their values", () => {
    expect(envSecrets({ ONDRA_SECRET_NAMES: "A_KEY,MISSING,SHORT", A_KEY: KEY, SHORT: "x" })).toEqual([{ name: "A_KEY", value: KEY }]);
    expect(envSecrets({})).toEqual([]);
  });

  it("reads the values passed only to be hidden", () => {
    expect(maskSecrets({ ONDRA_SECRET_MASKS: "ONDRA_SECRET_MASK_0=Deploy/Front:API_KEY,BAD", ONDRA_SECRET_MASK_0: "front-value-1" })).toEqual([{ name: "Deploy/Front:API_KEY", value: "front-value-1" }]);
    expect(maskSecrets({})).toEqual([]);
  });

  it("finds .env files in every folder but build output and hidden ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "secw-"));
    for (const [d, f] of [["", ".env"], ["", ".env.example"], ["Deploy/Front", ".env.local"], ["node_modules/x", ".env"], [".git", ".env"], ["a/b/c/d/e/f/g", ".env"]]) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, f), "K=v\n");
    }
    expect(envFilesUnder(dir)).toEqual([".env", "Deploy/Front/.env.local"]);
  });

  it("sees which names a command uses", () => {
    expect(namesUsed('curl -H "Authorization: Bearer $STRIPE_KEY" ${DB_URL:-x} $STRIPE_KEYS', ["STRIPE_KEY", "DB_URL", "OTHER"])).toEqual(["STRIPE_KEY", "DB_URL"]);
  });

  it("tells the model the names and folders, where uses are kept, never values", () => {
    const note = promptNote(["STRIPE_KEY", "WEB_TOKEN"], secretDirs({ ONDRA_SECRET_DIRS: "WEB_TOKEN=Deploy/Front" }));
    expect(note).toContain("`STRIPE_KEY`, `WEB_TOKEN` (Deploy/Front/.env)");
    expect(note).toContain("[secret:NAME]");
    expect(note).toContain("memory_search");
    expect(note).toContain("Settings › 시크릿");
  });

  it("hides values in tool results, from Ondra and from the folder's .env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-"));
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-proj-folderValue9\nDEBUG=verbose-mode\n");
    writeFileSync(join(dir, ".env.example"), "OPENAI_API_KEY=sk-example-value\n");
    mkdirSync(join(dir, "Deploy", "Front"), { recursive: true });
    writeFileSync(join(dir, "Deploy", "Front", ".env"), "WEB_TOKEN=deep-token-777\n");
    const handlers: Record<string, (e: any, ctx: any) => any> = {};
    const pi = { on: (name: string, fn: (e: any, ctx: any) => any) => (handlers[name] = fn) };
    const saved = { ...process.env };
    process.env.ONDRA_SECRET_NAMES = "STRIPE_KEY";
    process.env.STRIPE_KEY = KEY;
    process.env.ONDRA_DATA_DIR = dir;
    try {
      secrets(pi as any);
      const prompt = handlers.before_agent_start({ systemPrompt: "base" }, {});
      expect(prompt.systemPrompt).toContain("`STRIPE_KEY`");
      expect(prompt.systemPrompt).not.toContain(KEY);
      const out = handlers.tool_result(
        { toolName: "bash", content: [{ type: "text", text: `${KEY} sk-proj-folderValue9 verbose-mode sk-example-value deep-token-777` }, { type: "image", data: "x" }] },
        { cwd: dir },
      );
      expect(out.content[0].text).toBe("[secret:STRIPE_KEY] [secret:.env:OPENAI_API_KEY] verbose-mode sk-example-value [secret:Deploy/Front/.env:WEB_TOKEN]");
      expect(out.content[1]).toEqual({ type: "image", data: "x" });
      expect(handlers.tool_result({ toolName: "bash", content: [{ type: "text", text: "clean" }] }, { cwd: dir })).toBeUndefined();
      handlers.tool_call({ toolName: "bash", input: { command: "echo $STRIPE_KEY" } }, {});
      // memory takes the name, never the value
      expect(handlers.tool_call({ toolName: "memory_save", input: { text: `STRIPE_KEY는 ${KEY}` } }, { cwd: dir })).toMatchObject({ block: true });
      expect(handlers.tool_call({ toolName: "memory_save", input: { text: "WEB_TOKEN deep-token-777" } }, { cwd: dir })).toMatchObject({ block: true });
      expect(handlers.tool_call({ toolName: "memory_save", input: { text: "`STRIPE_KEY`: 테스트 결제 키" } }, { cwd: dir })).toBeUndefined();
      const { readFileSync } = await import("node:fs");
      const log = readFileSync(join(dir, "secrets-audit.jsonl"), "utf8");
      expect(log).toContain('"kind":"used"');
      expect(log).toContain('"kind":"hidden"');
      expect(log).toContain('"kind":"refused"');
      expect(log).not.toContain(KEY);
    } finally {
      process.env = saved;
    }
  });
});
