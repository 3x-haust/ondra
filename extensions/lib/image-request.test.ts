import { describe, expect, it } from "vitest";
import { accountOf, imageOf, imageRequest } from "./image-request";

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

describe("image", () => {
  it("reads the ChatGPT account out of the login's token", () => {
    expect(accountOf(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }))).toBe("acc-1");
    expect(accountOf("not a token")).toBeUndefined();
  });
  it("asks for one image, with the reference pictures", () => {
    const r = imageRequest("gpt-x", "a cat waving", [{ mime: "image/png", b64: "AAA" }], { background: "transparent" });
    expect(r.tools).toEqual([expect.objectContaining({ type: "image_generation", background: "transparent", output_format: "png" })]);
    expect(r.input[0].content).toEqual([
      { type: "input_text", text: "a cat waving" },
      { type: "input_image", image_url: "data:image/png;base64,AAA" },
    ]);
    expect(r).toMatchObject({ model: "gpt-x", stream: true, store: false });
  });
  it("takes the picture out of the events, or says why there is none", () => {
    const ev = (o: object) => `data: ${JSON.stringify(o)}\n`;
    expect(imageOf(ev({ type: "response.output_item.done", item: { type: "image_generation_call", result: "PNG64" } })).b64).toBe("PNG64");
    expect(imageOf(ev({ type: "response.output_text.delta", delta: "I can't" }) + ev({ type: "response.failed", response: { error: { message: "nope" } } }))).toEqual({ b64: undefined, error: "nope", said: "I can't" });
  });
});
