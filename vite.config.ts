import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
// Engine and state modules hold live sessions, maps and subscriptions: swapping
// them in place leaves the old copy running next to the new one (events heard
// twice, edits going to the wrong copy). A change there reloads the page instead.
const reloadOnCore = {
  name: "reload-on-core",
  handleHotUpdate({ file, server }: { file: string; server: { ws: { send: (p: { type: "full-reload" }) => void } } }) {
    if (/\/src\/(engine|state|lib)\//.test(file)) {
      server.ws.send({ type: "full-reload" });
      return [];
    }
  },
};

export default defineConfig(() => ({
  plugins: [solid(), reloadOnCore],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
