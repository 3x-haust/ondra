// The phone's link to the Mac: its own key (kept in this browser), the Mac it was paired
// with, and one live session that comes back on its own when the network drops.
import { createSignal } from "solid-js";
import init, { connect, newKey, type Session } from "../pkg/ondra_remote_client.js";

export interface Mac { id: string; name: string }
export type Phase =
  | { k: "idle" }
  | { k: "connecting" }
  | { k: "waiting" } // the Mac is asked to let this phone in
  | { k: "ok" }
  | { k: "lost"; retryIn: number }
  | { k: "denied"; reason: "unknown" | "refused" }
  | { k: "error"; message: string };

const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string | null) {
    try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode: lives until reload */ }
  },
};

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const [phase, setPhase] = createSignal<Phase>({ k: "idle" });
export const [mac, setMac] = createSignal<Mac | null>(JSON.parse(store.get("ondra.mac") ?? "null"));

let ready: Promise<unknown> | undefined;
let session: Session | undefined;
let listener: (msg: Record<string, unknown>) => void = () => {};
let retry: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let wanted = false;

async function key(): Promise<Uint8Array> {
  await (ready ??= init());
  const saved = store.get("ondra.key");
  if (saved) return unb64(saved);
  const k = newKey();
  store.set("ondra.key", b64(k));
  return k;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android" : "Android 태블릿";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "브라우저";
}

export const onMessage = (fn: typeof listener) => (listener = fn);

export function send(msg: Record<string, unknown>): boolean {
  return !!session?.send(JSON.stringify(msg));
}

/** Connect to `to` (with a pairing code the first time); keeps trying while it's wanted. */
export async function open(to: Mac, pair?: string) {
  wanted = true;
  clearTimeout(retry);
  setMac(to);
  setPhase({ k: "connecting" });
  try {
    const k = await key();
    const hello = JSON.stringify({ t: "hello", name: deviceName(), ...(pair ? { pair } : {}) });
    const s = await connect(
      to.id,
      k,
      hello,
      (line: string) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(line); } catch { return; }
        if (m.t === "waiting") setPhase({ k: "waiting" });
        else if (m.t === "ok") {
          attempt = 0;
          store.set("ondra.mac", JSON.stringify(to));
          setPhase({ k: "ok" });
        } else if (m.t === "denied") {
          wanted = false;
          if (m.reason === "unknown") store.set("ondra.mac", null);
          setPhase({ k: "denied", reason: m.reason === "refused" ? "refused" : "unknown" });
        } else listener(m);
      },
      () => {
        session = undefined;
        if (wanted) again(to);
      },
    );
    session = s;
  } catch (e) {
    session = undefined;
    if (wanted && !pair) again(to);
    else setPhase({ k: "error", message: String(e) });
  }
}

function again(to: Mac) {
  const wait = Math.min(30, 2 ** Math.min(attempt++, 5));
  setPhase({ k: "lost", retryIn: wait });
  retry = setTimeout(() => void open(to), wait * 1000);
}

/** coming back to the page after it slept: try now instead of waiting */
export function wake() {
  const m = mac();
  const p = phase();
  if (m && wanted && p.k === "lost") {
    attempt = 0;
    void open(m);
  }
}

export function forget() {
  wanted = false;
  clearTimeout(retry);
  void session?.close();
  session = undefined;
  store.set("ondra.mac", null);
  setMac(null);
  setPhase({ k: "idle" });
}
