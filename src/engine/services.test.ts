import { afterEach, describe, expect, it, vi } from "vitest";
import * as native from "../lib/native";
import { addServer, mcpArgs, mcpSig, PRESETS, removeServer, secretVar, serverConfig, serverName, serverStates, servicesHands } from "./services";

afterEach(() => vi.restoreAllMocks());

describe("connected services, each workspace its own", () => {
  it("writes a server deferred (reached through use), its client secret named by env var only", () => {
    expect(serverConfig({ name: "notion", url: "https://mcp.notion.com/mcp", about: "pages" })).toEqual({ type: "http", url: "https://mcp.notion.com/mcp", exposure: "deferred", description: "pages" });
    const gmail = PRESETS.find((p) => p.id === "gmail")!;
    expect(serverConfig({ name: "gmail", url: gmail.url, clientId: "id.apps", secret: true, scope: gmail.ownApp!.scope })).toEqual({
      type: "http",
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      oauth: { clientId: "id.apps", clientSecret: "${ONDRA_MCP_SECRET_GMAIL}", scope: expect.stringContaining("https://www.googleapis.com/auth/gmail.readonly") },
      exposure: "deferred",
    });
    // Slack's app has one redirect URL: its sign-in listens on that port
    expect(serverConfig({ name: "slack", url: "https://mcp.slack.com/mcp", clientId: "1.2", secret: true }).oauth).toMatchObject({ callbackPort: 8788 });
    expect(serverConfig({ name: "files", command: "npx", args: ["-y", "srv"] })).toEqual({ command: "npx", args: ["-y", "srv"], exposure: "deferred" });
    expect(secretVar("google-calendar")).toBe("ONDRA_MCP_SECRET_GOOGLE_CALENDAR");
    expect(serverName(" My Jira! ")).toBe("my-jira");
  });

  it("a space with a service on loads the MCP extension, and what it has is in main's start signature", async () => {
    const servers = vi.spyOn(native, "mcpServers");
    servers.mockResolvedValue({});
    expect(await mcpArgs("work")).toEqual([]);
    servers.mockResolvedValue({ slack: { url: "x", enabled: false } });
    expect(await mcpArgs("work")).toEqual([]);
    expect(await mcpSig("work")).toBe("");
    servers.mockResolvedValue({ slack: { url: "x" }, notion: { url: "y" } });
    expect(await mcpArgs("work")).toEqual(["--extension", "builtin:mcp"]);
    expect(await mcpSig("work")).toBe("notion,slack");
    expect(servers).toHaveBeenLastCalledWith("work");
  });

  it("adding keeps the others and puts the secret in the keychain; removing signs out first", async () => {
    vi.spyOn(native, "mcpServers").mockResolvedValue({ notion: { url: "y" } });
    const save = vi.spyOn(native, "mcpSave").mockResolvedValue();
    const keep = vi.spyOn(native, "mcpSecretSet").mockResolvedValue();
    await addServer("work", "slack", { type: "http", url: "x" }, " s3cret ");
    expect(keep).toHaveBeenCalledWith("work", "slack", "s3cret");
    expect(save).toHaveBeenLastCalledWith("work", { notion: { url: "y" }, slack: { type: "http", url: "x" } });
    const cli = vi.spyOn(native, "mcpCli").mockResolvedValue({ code: 0, out: "" });
    const drop = vi.spyOn(native, "mcpSecretDelete").mockResolvedValue();
    await removeServer("work", "notion");
    expect(cli).toHaveBeenCalledWith("work", ["logout", "notion"]);
    expect(save).toHaveBeenLastCalledWith("work", {});
    expect(drop).toHaveBeenCalledWith("work", "notion");
  });

  it("reads each server's state from the engine's list", async () => {
    vi.spyOn(native, "mcpCli").mockResolvedValue({
      code: 1,
      out: 'note\n{"servers":[{"name":"slack","state":"needs-auth","tools":[]},{"name":"notion","state":"connected","tools":["search","fetch"]}],"errors":[]}',
    });
    expect(await serverStates("work")).toEqual([
      { name: "slack", state: "needs-auth", tools: [] },
      { name: "notion", state: "connected", tools: ["search", "fetch"] },
    ]);
  });

  it("main or a job connects one itself: the secret by its saved name, then the sign-in in the browser", async () => {
    vi.spyOn(native, "mcpServers").mockResolvedValue({});
    const save = vi.spyOn(native, "mcpSave").mockResolvedValue();
    const from = vi.spyOn(native, "mcpSecretFrom").mockResolvedValue();
    const cli = vi.spyOn(native, "mcpCli").mockResolvedValue({ code: 0, out: 'Signed in to MCP server "notion" (12 tools).' });
    expect(await servicesHands("work", { action: "connect", preset: "notion" })).toMatchObject({ connected: "notion", signed_in: true });
    expect(save).toHaveBeenLastCalledWith("work", { notion: expect.objectContaining({ url: "https://mcp.notion.com/mcp", exposure: "deferred" }) });
    expect(cli).toHaveBeenLastCalledWith("work", ["login", "notion", "--timeout", "300"]);
    // Gmail without the user's own app: what to make, nothing written
    save.mockClear();
    expect(await servicesHands("work", { action: "connect", preset: "gmail" })).toMatchObject({ error: expect.stringContaining("client_id"), link: expect.any(String) });
    expect(save).not.toHaveBeenCalled();
    await servicesHands("work", { action: "connect", preset: "gmail", client_id: "id.apps", client_secret: "GMAIL_SECRET" });
    expect(from).toHaveBeenCalledWith("work", "gmail", "GMAIL_SECRET");
    expect(save).toHaveBeenLastCalledWith("work", { gmail: expect.objectContaining({ oauth: expect.objectContaining({ clientId: "id.apps", clientSecret: "${ONDRA_MCP_SECRET_GMAIL}" }) }) });
    // any server by command
    await servicesHands("work", { action: "connect", name: "Files", command: "npx -y files-mcp" });
    expect(save).toHaveBeenLastCalledWith("work", { files: { command: "npx", args: ["-y", "files-mcp"], exposure: "deferred" } });
    expect(await servicesHands("work", { action: "remove", name: "nope" })).toEqual({ error: "no service nope" });
  });
});
