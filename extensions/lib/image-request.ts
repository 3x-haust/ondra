// The image tool's request to GPT and its answer, apart from the engine (extensions/image.ts) so they can be tested.

const JWT_CLAIM = "https://api.openai.com/auth";

/** the ChatGPT account id inside the login's token (sent with every request, as the engine does) */
export function accountOf(token: string): string | undefined {
  try {
    const part = token.split(".")[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return json?.[JWT_CLAIM]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

/** the request: the words, the reference pictures, and image_generation as the one tool to use */
export function imageRequest(model: string, prompt: string, refs: { mime: string; b64: string }[], o: { size?: string; background?: string }) {
  return {
    model,
    instructions:
      "You make images. Call the image_generation tool exactly once with a prompt that does what the user asks; when reference images are given, keep their character, style and colours exactly unless told otherwise. Don't ask questions.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }, ...refs.map((r) => ({ type: "input_image", image_url: `data:${r.mime};base64,${r.b64}` }))],
      },
    ],
    tools: [{ type: "image_generation", output_format: "png", size: o.size ?? "auto", background: o.background ?? "auto", quality: "high" }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: true,
    store: false,
  };
}

/** the picture out of the response's events (server-sent events), or why there is none */
export function imageOf(sse: string): { b64?: string; error?: string; said?: string } {
  let b64: string | undefined;
  let error: string | undefined;
  let said = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let e: any;
    try {
      e = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    const item = e.item ?? e.output_item;
    if (e.type === "response.output_item.done" && item?.type === "image_generation_call" && typeof item.result === "string" && item.result) b64 = item.result;
    if (e.type === "response.image_generation_call.partial_image" && typeof e.partial_image_b64 === "string" && !b64) b64 = e.partial_image_b64;
    if (e.type === "response.output_text.delta" && typeof e.delta === "string") said += e.delta;
    if (e.type === "error" || e.type === "response.failed") error = e.message ?? e.error?.message ?? e.response?.error?.message ?? JSON.stringify(e).slice(0, 300);
  }
  return { b64, error, said: said.trim() || undefined };
}
