import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ fromSecret: vi.fn(async (_n: string) => {}), has: vi.fn(async () => false) }));
vi.mock("../lib/native", () => ({ discordTokenFromSecret: native.fromSecret, discordTokenHas: native.has }));
const discord = vi.hoisted(() => ({ setAgent: vi.fn(), startAgent: vi.fn(async () => {}), stopAgent: vi.fn() }));
vi.mock("./discord", () => discord);

import { checked, readSettings, writeSettings } from "./appSettings";
import { setState, state } from "../state/store";

describe("ondra_settings (appSettings)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState("settings", "theme", "system");
    setState("settings", "isolate", true);
    setState("settings", "permission", "auto");
  });

  it("reads every setting with where it is and what it takes, and only whether a token is set", async () => {
    native.has.mockResolvedValueOnce(true);
    const all = (await readSettings()) as Record<string, { value: unknown; where: string }>;
    expect(all.theme.value).toBe("system");
    expect(all.isolate.where).toContain("워크트리");
    expect(all["agent.token"].value).toBe("set (in the keychain)");
  });

  it("changes what the user asked and says what it was", async () => {
    const r = (await writeSettings({ theme: "dark", isolate: false })) as Record<string, { changed: boolean; was?: unknown; now?: unknown }>;
    expect(r.theme).toEqual({ changed: true, was: "system", now: "dark" });
    expect(state.settings.isolate).toBe(false);
  });

  it("refuses values a setting doesn't take, and keys that aren't settings", async () => {
    const r = (await writeSettings({ permission: "everything", theme: "pink", accounts: [] })) as Record<string, { changed: boolean; why?: string }>;
    expect(r.permission.changed).toBe(false);
    expect(r.theme.changed).toBe(false);
    expect(r.accounts).toEqual({ changed: false, why: "no setting accounts" });
    expect(state.settings.permission).toBe("auto");
    expect(state.settings.theme).toBe("system");
  });

  it("the bot token moves from a saved secret by name; no value passes", async () => {
    const r = (await writeSettings({ "agent.token": "DISCORD_BOT_TOKEN" })) as Record<string, { changed: boolean }>;
    expect(native.fromSecret).toHaveBeenCalledWith("DISCORD_BOT_TOKEN");
    expect(r["agent.token"].changed).toBe(true);
  });

  it("turning the agent on starts it", async () => {
    await writeSettings({ "agent.on": true, "agent.channels": "1, 2" });
    expect(discord.setAgent).toHaveBeenCalledWith({ on: true });
    expect(discord.startAgent).toHaveBeenCalled();
    expect(discord.setAgent).toHaveBeenCalledWith({ channels: ["1", "2"] });
  });

  it("booleans given as text still count", () => {
    expect(checked("isolate", "false")).toEqual({ ok: true, value: false });
  });
});
