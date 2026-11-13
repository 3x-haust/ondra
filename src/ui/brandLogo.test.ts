import { describe, expect, it } from "vitest";
import { icons, shards } from "virtual:simple-icons-all";
import { findIn, indexOf, norm, resolve, sendable } from "./brandLogo";

const full = indexOf(icons);

describe("a name → a logo", () => {
  it("finds every simple-icons brand by slug, title or other name", async () => {
    expect(icons.length).toBeGreaterThan(3000);
    expect(findIn(full, "clerk")?.slug).toBe("clerk");
    expect(findIn(full, "neon")).toBeUndefined(); // not in simple-icons: only online
    expect(findIn(full, "Next.js")?.slug).toBe("nextdotjs");
    expect(findIn(full, "nextjs")?.slug).toBe("nextdotjs");
    expect(findIn(full, "C++")?.slug).toBe("cplusplus");
    expect(findIn(full, "aws-lambda")?.slug).toBe("awslambda");
    expect(findIn(full, "postgres")?.slug).toBe("postgresql"); // Logos.tsx's other names hold here too
    expect(findIn(full, "k8s")?.slug).toBe("kubernetes");
    expect(findIn(full, "Clerk")?.title).toBe("Clerk");
    // exact names only: no brand guessed out of a word
    expect(findIn(full, "order api")).toBeUndefined();
    expect(findIn(full, "x")).toBeUndefined();
    // the drawing is in the entry's shard
    const e = icons.find((i) => i[0] === "clerk")!;
    expect((await shards[e[4]]()).default.clerk).toMatch(/^m/i);
    expect(norm("Node.js (20)")).toBe("nodejs");
  });

  it("asks online only for a block's logo or a brand the label matched, never the label", () => {
    // a label naming a brand: its title goes, not the label
    expect(resolve({ label: "order-api (Node)" }, full)).toMatchObject({ icon: { slug: "nodedotjs" }, online: "Node.js" });
    expect(resolve({ label: "Clerk" }, full)).toMatchObject({ icon: { slug: "clerk" }, online: "Clerk" });
    // an internal name: nothing at all
    expect(resolve({ label: "billing-service", note: "주문 처리" }, full)).toEqual({});
    expect(resolve({ label: "주문 서비스" }, full)).toEqual({});
    // a logo: by its brand title when simple-icons has it, else as written
    expect(resolve({ label: "DB", logo: "postgres" }, full)).toMatchObject({ icon: { slug: "postgresql" }, online: "PostgreSQL" });
    expect(resolve({ label: "auth", logo: "clerk" }, full)).toMatchObject({ icon: { slug: "clerk" }, online: "Clerk" });
    expect(resolve({ label: "rpc", logo: "orpc" }, full)).toEqual({ icon: undefined, online: "orpc" });
    expect(resolve({ label: "db", logo: "neon" }, full)).toEqual({ icon: undefined, online: "neon" });
    // a logo that isn't a plain brand name stays here
    expect(resolve({ label: "x", logo: "our/internal thing" }, full).online).toBeUndefined();
  });

  it("waits for the full set before asking for a name the bundled set misses", () => {
    expect(resolve({ label: "Clerk" })).toEqual({ waiting: true });
    expect(resolve({ label: "x", logo: "clerk" })).toEqual({ icon: undefined, waiting: true });
    // a bundled one needs no wait
    expect(resolve({ label: "Postgres" })).toMatchObject({ icon: { slug: "postgresql" }, online: "PostgreSQL" });
  });

  it("sends plain brand names only", () => {
    expect(sendable("Better Auth")).toBe(true);
    expect(sendable("C++")).toBe(true);
    expect(sendable("https://corp.internal/x")).toBe(false);
    expect(sendable("결제 서비스")).toBe(false);
    expect(sendable("a".repeat(61))).toBe(false);
  });
});
