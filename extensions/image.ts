// Image generation for jobs, on the user's own GPT login (the ChatGPT account Ondra signs in with):
// the `image` tool asks GPT's image_generation for a picture, optionally from reference pictures
// (the same character in a new pose, an edit of a picture), and saves it as a PNG. No API key, no
// billing per call: it spends the ChatGPT plan's usage, like a GPT job does.
// Called through use (deferred): pet-maker draws a pet's poses with it, any job can make images.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { accountOf, imageOf, imageRequest } from "./lib/image-request";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_REFS = 6;
const TIMEOUT_MS = 240_000;

const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: t }], details });

export default function (pi: any) {
  pi.registerTool({
    name: "image",
    label: "Image",
    exposure: "deferred",
    description: [
      "Generate or edit an image with GPT image generation on the user's ChatGPT login (no API key, uses their plan's usage). Saves a PNG to `out` and shows it to you.",
      "prompt: what to draw, specific (subject, pose, style, framing, background). refs: up to 6 image paths it keeps the character/style of (a new pose of the same character, an edit of a picture).",
      "For sprites and pets: one pose per call, the whole body, a plain flat background (or background=transparent), the same framing every call.",
    ].join("\n"),
    promptSnippet: "Generate or edit images with GPT (prompt, refs, out)",
    parameters: Type.Object({
      prompt: Type.String({ description: "what to draw" }),
      out: Type.String({ description: "where to save the PNG (absolute, or relative to the working folder)" }),
      refs: Type.Optional(Type.Array(Type.String(), { description: "reference images to keep the character/style of" })),
      size: Type.Optional(Type.Union([Type.Literal("1024x1024"), Type.Literal("1024x1536"), Type.Literal("1536x1024"), Type.Literal("auto")])),
      background: Type.Optional(Type.Union([Type.Literal("transparent"), Type.Literal("opaque"), Type.Literal("auto")])),
    }),
    async execute(_id: string, p: any, signal: AbortSignal | undefined, _up: unknown, ctx: any) {
      const reg = ctx?.modelRegistry;
      const all: any[] = reg?.getAvailable?.() ?? [];
      const model = ctx?.model?.provider === "openai-codex" ? ctx.model : all.find((m) => m.provider === "openai-codex");
      if (!model) return text("No GPT (ChatGPT) login here: images need Ondra signed in with GPT. Say so to the user, or draw it another way.", { ok: false });
      const auth = await reg.getApiKeyAndHeaders(model);
      const token: string | undefined = auth?.ok ? auth.apiKey : undefined;
      const account = token && accountOf(token);
      if (!token || !account) return text(`The GPT login can't be used for images (${auth?.error ?? "no account in it"}).`, { ok: false });
      const cwd = process.cwd();
      const at = (f: string) => (isAbsolute(f) ? f : resolve(cwd, f));
      const refs: { mime: string; b64: string }[] = [];
      for (const f of (p.refs ?? []).slice(0, MAX_REFS)) {
        const path = at(String(f));
        const mime = MIME[extname(path).toLowerCase()];
        if (!mime || !existsSync(path)) return text(`Reference ${f}: not a png/jpg/webp/gif file that exists.`, { ok: false });
        refs.push({ mime, b64: readFileSync(path).toString("base64") });
      }
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const res = await fetch(CODEX_URL, {
        method: "POST",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          ...(auth.headers ?? {}),
          Authorization: `Bearer ${token}`,
          "chatgpt-account-id": account,
          originator: "pi",
          "OpenAI-Beta": "responses=experimental",
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(imageRequest(model.id, String(p.prompt), refs, { size: p.size, background: p.background })),
      }).catch((e: unknown) => e as Error);
      if (res instanceof Error) return text(`Image request failed: ${res.message}`, { ok: false });
      const body = await res.text();
      if (!res.ok) return text(`Image request failed: HTTP ${res.status} ${body.slice(0, 400)}`, { ok: false, status: res.status });
      const got = imageOf(body);
      if (!got.b64) return text(`No image came back${got.error ? `: ${got.error}` : ""}${got.said ? ` (it said: ${got.said.slice(0, 300)})` : ""}.`, { ok: false });
      const out = at(String(p.out));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(got.b64, "base64"));
      return {
        content: [
          { type: "text", text: `Saved ${out}` },
          { type: "image", data: got.b64, mimeType: "image/png" },
        ],
        details: { ok: true, out },
      };
    },
  });
}
