// Every link the app opens goes through openLink: web pages in the panel's browser
// (or the default browser, by the setting, ⌘/⌥-click or the link's menu), files in the
// app's viewer. The rules are in lib/links.ts.
import { openExternal, revealPath } from "../lib/native";
import { appName } from "../lib/brand";
import { isWeb, routeLink, type LinkRoute } from "../lib/links";
import { state } from "../state/store";
import { openBrowser, previewFile, toast, view } from "../state/ui";
import { expand } from "../engine/rpc";
import { openMenuAt, type MenuEntry } from "./taskMenu";
import { t } from "../i18n";

export interface OpenLinkOpts {
  /** the click (or key) that opened it: ⌘ or ⌥ held sends it to the default browser */
  event?: { metaKey?: boolean; altKey?: boolean };
  /** it needs the real browser (an app sign-in, a device code page) */
  outside?: boolean;
}

/** the panel shows beside Main and a task (not the canvas, memory, results or settings) */
const panelHere = () => view().name === "main" || view().name === "task";

/** Where a link would open now. */
export const linkRoute = (url: string, opts: OpenLinkOpts = {}): LinkRoute =>
  routeLink(url, {
    setting: state.settings.links,
    outsideKey: !!(opts.event?.metaKey || opts.event?.altKey),
    outside: opts.outside,
    panel: panelHere(),
  });

/** Open a link where it belongs (see lib/links.ts). */
export function openLink(url: string, opts: OpenLinkOpts = {}): LinkRoute {
  const r = linkRoute(url, opts);
  if (r.to === "inside") openBrowser(r.target);
  else if (r.to === "outside") void openExternal(r.target);
  else if (r.to === "file") {
    // ⌘/⌥: in Finder; otherwise the app's own viewer
    if (opts.event?.metaKey || opts.event?.altKey) void revealPath(expand(r.target.replace(/^file:\/\//, "").replace(/:\d+(:\d+)?$/, "")));
    else previewFile(r.target);
  }
  return r;
}

/** The default browser, whatever the setting. */
export const openOutside = (url: string) => void openExternal(url);

/** A web link's right-click menu: open here, in the default browser, copy. */
export function linkMenuItems(url: string): MenuEntry[] {
  const here = routeLink(url, { panel: panelHere() }).to === "inside";
  return [
    ...(here ? [{ id: "open-inside", label: t("{name}에서 열기", { name: appName() }), icon: "globe", run: () => void openBrowser(url) }] : []),
    { id: "open-outside", label: t("기본 브라우저에서 열기"), icon: "external", run: () => openOutside(url) },
    "sep",
    { id: "copy-link", label: t("링크 복사"), icon: "copy", run: () => void navigator.clipboard.writeText(url).then(() => toast(t("복사했어요"))) },
  ];
}

/** onContextMenu for something that opens `url`: its link menu (only for a web link). */
export const linkMenu = (url: string | undefined) => (e: MouseEvent) => {
  if (!url || !isWeb(url)) return;
  e.preventDefault();
  e.stopPropagation();
  openMenuAt(`link:${url}`, () => linkMenuItems(url), e);
};
