import { expect, it, vi } from "vitest";
import computer from "../../extensions/computer";

it("does not expose desktop access on Windows even when a helper path is configured", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const registerTool = vi.fn();
  const on = vi.fn();
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("ONDRA_COMPUTER_HOST", "1");
    vi.stubEnv("ONDRA_COMPUTER_HOST_BIN", process.execPath);
    computer({ on, registerTool });
    expect(registerTool).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
  }
});
