// Where a link opens. Web pages open in the app's own browser (the panel's 브라우저 tab,
// the one every job shares); the rest goes where it can be shown: files in the app's
// viewer, mail and other apps' links, sign-ins and downloads in the system's browser.
// Pure, so the rules are tested on their own (links.test.ts); ui/links.ts acts on them.

/** inside: the panel's browser. outside: the system's default browser (or the app for the scheme).
 *  file: the app's file viewer (outside = Finder). none: nothing to open. */
export type LinkPlace = "inside" | "outside" | "file" | "none";
/** Settings › 일반 › 링크 열기 */
export type LinkSetting = "inside" | "outside";

export interface LinkContext {
  /** the user's choice; inside when not set */
  setting?: LinkSetting;
  /** ⌘ or ⌥ held on the click: the default browser this time */
  outsideKey?: boolean;
  /** the caller knows it needs the real browser (an app sign-in) */
  outside?: boolean;
  /** the panel can show here (Main and a task have it; the canvas, memory and settings don't) */
  panel?: boolean;
}

export interface LinkRoute {
  to: LinkPlace;
  /** what to open: the URL, or the file path */
  target: string;
  /** why it goes there (for tests and reading the rules) */
  why: "web" | "setting" | "key" | "asked" | "no-panel" | "download" | "sign-in" | "scheme" | "file" | "bad";
}

/** what an app can open on its own (Mail, a phone call); anything else isn't handed out */
const APP_SCHEMES = new Set(["mailto:", "tel:"]);
/** files a browser saves rather than shows */
const DOWNLOAD = /\.(dmg|pkg|mpkg|zip|tar|tgz|gz|bz2|xz|7z|rar|exe|msi|deb|rpm|appimage|iso|apk|ipa|xip|crx|vsix)$/i;
/** sign-in pages that refuse an embedded webview, or want the passkeys and passwords of the real browser */
const SIGN_IN_HOSTS = new Set(["accounts.google.com", "appleid.apple.com", "login.microsoftonline.com", "login.live.com"]);
const DEVICE_PAGES = /^(github\.com\/login\/(device|oauth)|microsoft\.com\/devicelogin|www\.microsoft\.com\/devicelogin)/i;

/** A local path a link can mean: /abs, ~/x, file:///abs. */
export const isPath = (s: string) => /^(\/|~\/|~$|file:\/\/)/.test(s);
/** An http(s) address. */
export const isWeb = (s: string) => /^https?:\/\/[^\s/]/i.test(s.trim());

/** An OAuth or device sign-in: the provider wants the system's browser (and its callback). */
export function isSignIn(u: URL): boolean {
  if (SIGN_IN_HOSTS.has(u.hostname.toLowerCase())) return true;
  if (DEVICE_PAGES.test(`${u.hostname}${u.pathname}`)) return true;
  const q = u.searchParams;
  return q.has("client_id") && (q.has("redirect_uri") || q.has("response_type"));
}

/** Where `raw` opens, and why. */
export function routeLink(raw: string, cx: LinkContext = {}): LinkRoute {
  const s = raw.trim();
  if (!s) return { to: "none", target: s, why: "bad" };
  if (isPath(s)) return { to: "file", target: s, why: "file" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { to: "none", target: s, why: "bad" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    // mail, a phone number: their own app. javascript:, data: and the like: never
    return APP_SCHEMES.has(u.protocol) ? { to: "outside", target: s, why: "scheme" } : { to: "none", target: s, why: "bad" };
  }
  const out = (why: LinkRoute["why"]): LinkRoute => ({ to: "outside", target: s, why });
  if (cx.outside) return out("asked");
  if (cx.outsideKey) return out("key");
  if (isSignIn(u)) return out("sign-in");
  if (DOWNLOAD.test(u.pathname) || /\/releases\/download\//.test(u.pathname)) return out("download");
  if (cx.setting === "outside") return out("setting");
  if (cx.panel === false) return out("no-panel");
  return { to: "inside", target: s, why: "web" };
}

/** A hover title for a link whose text doesn't already say where it goes (none when it does). */
export function linkTip(href: string, text: string): string | undefined {
  const bare = (x: string) => x.trim().replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
  if (!href || bare(text) === bare(href)) return undefined;
  return isWeb(href) ? href.replace(/^https?:\/\/(www\.)?/i, "") : href;
}
