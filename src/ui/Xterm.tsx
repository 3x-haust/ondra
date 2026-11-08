// A real terminal (xterm.js) on a PTY from the Rust side.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onCleanup, onMount } from "solid-js";
import { onEvent, ptyClose, ptyResize, ptyWrite } from "../lib/native";
import { t } from "../i18n";

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function Xterm(props: {
  id: string;
  /** Start the PTY with the measured size. */
  open: (cols: number, rows: number) => Promise<void>;
  onExit?: (code: number | null) => void;
  /** Keep the PTY running when this view goes away. */
  keep?: boolean;
}) {
  let host!: HTMLDivElement;
  // Registered up front: a cleanup added after an await would never run.
  let teardown: (() => void) | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    teardown?.();
  });
  onMount(async () => {
    const term = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: css("--code-bg"),
        foreground: css("--ink"),
        cursor: css("--ink"),
        selectionBackground: "rgba(127,127,127,.35)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    const unData = await onEvent<{ id: string; data: string }>("pty:data", (p) => p.id === props.id && term.write(p.data));
    const unExit = await onEvent<{ id: string; code: number | null }>("pty:exit", (p) => {
      if (p.id !== props.id) return;
      term.write(`\r\n\x1b[2m[${t("종료됨")}]\x1b[0m\r\n`);
      props.onExit?.(p.code);
    });
    term.onData((d) => ptyWrite(props.id, d));
    await props.open(term.cols, term.rows);
    const ro = new ResizeObserver(() => {
      fit.fit();
      ptyResize(props.id, term.cols, term.rows);
    });
    ro.observe(host);
    term.focus();
    teardown = () => {
      ro.disconnect();
      unData();
      unExit();
      term.dispose();
      if (!props.keep) ptyClose(props.id);
    };
    if (disposed) teardown();
  });
  return <div class="xterm-host" ref={host} />;
}
