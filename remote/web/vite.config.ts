// The phone's page for remote control: its own small app, built to dist-remote/ and served
// as static files (a dev build serves it on this Wi-Fi, port 4740).
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "./",
  plugins: [solid()],
  build: { outDir: fileURLToPath(new URL("../../dist-remote", import.meta.url)), emptyOutDir: true, target: "es2022" },
  server: { host: "0.0.0.0", port: 4740, strictPort: true, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
