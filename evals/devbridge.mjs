// The dev app's eval bridge (src-tauri/src/devbridge.rs): runs JS in the app and returns its
// value. Needs the dev app running (`pnpm tauri dev`); the token stays in the app's data dir.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ONDRA_DATA_DIR / ONDRA_DEVBRIDGE_PORT: a second dev app on its own empty data (see engine.rs data_dir)
const DATA = process.env.ONDRA_DATA_DIR || join(homedir(), "Library/Application Support/dev.3xhaust.ondra");
const token = () => readFileSync(join(DATA, "devbridge.token"), "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.ONDRA_DEVBRIDGE_PORT) || 17321;

export async function app(js) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/eval`, { method: "POST", headers: { "x-token": token() }, body: js, signal: AbortSignal.timeout(600_000) });
      const t = await r.text();
      if (t.trim() && t.trim() !== '"unauthorized"') {
        const v = JSON.parse(t);
        if (typeof v === "string" && v.startsWith("ERR")) throw new Error(v);
        return v;
      }
    } catch (e) {
      if (String(e).includes("ERR")) throw e;
    }
    await sleep(3000);
  }
  throw new Error("dev bridge not answering: is `pnpm tauri dev` running?");
}
