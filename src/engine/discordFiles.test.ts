import { describe, expect, it } from "vitest";
import { localLinks, localPath, openClick, openRow } from "./discordFiles";

const kinds: Record<string, "file" | "big" | "folder" | "none"> = {
  "/var/folders/8r/T/ondra-scratch/build/Products/Debug/": "folder",
  "/Users/me/out/report.pdf": "file",
  "/Users/me/out/huge.mov": "big",
};
const kind = async (p: string) => kinds[p] ?? "none";

describe("this Mac's files and folders in what goes to Discord", () => {
  it("reads a link's target as a path here, and leaves web links alone", () => {
    expect(localPath("file:///Users/me/a%20b.txt")).toBe("/Users/me/a b.txt");
    expect(localPath("<file:///tmp/x>")).toBe("/tmp/x");
    expect(localPath("https://example.com/a")).toBeUndefined();
    expect(localPath("#top")).toBeUndefined();
  });

  it("a file goes up with the message, a folder or a big file gets a button, a missing one shows its path", async () => {
    const out = await localLinks(
      "깔려 있는 Orbit 끄고 [테스트 빌드 폴더](file:///var/folders/8r/T/ondra-scratch/build/Products/Debug/)에 있는 걸로 열어 봐. [보고서](/Users/me/out/report.pdf), [영상](/Users/me/out/huge.mov), [없는 것](/Users/me/gone.txt), ![shot](/x.png) [사이트](https://a.dev)",
      kind,
    );
    expect(out.text).toBe("깔려 있는 Orbit 끄고 테스트 빌드 폴더에 있는 걸로 열어 봐. 보고서, 영상, 없는 것 (`~/gone.txt`), shot (`/x.png`) [사이트](https://a.dev)");
    expect(out.files).toEqual(["/Users/me/out/report.pdf"]);
    expect(out.open.map((o) => o.label)).toEqual(["테스트 빌드 폴더", "영상"]);
  });

  it("a picture on this Mac goes up and its words go away", async () => {
    const out = await localLinks("아까 판 띄운다 해놓고 안 올렸네\n![](/tmp/metachess/board.png)", async (p) => (p === "/tmp/metachess/board.png" ? "file" : "none"));
    expect(out).toMatchObject({ text: "아까 판 띄운다 해놓고 안 올렸네", files: ["/tmp/metachess/board.png"] });
  });

  it("a bare file:// link too", async () => {
    const out = await localLinks("여기 file:///Users/me/out/report.pdf 있어", kind);
    expect(out).toMatchObject({ text: "여기 report.pdf 있어", files: ["/Users/me/out/report.pdf"] });
  });

  it("each button finds its place again when clicked", () => {
    const [row] = openRow([{ label: "테스트 빌드 폴더", path: "/a/Debug" }]) as { components: { custom_id: string; label: string }[] }[];
    expect(row.components[0].label).toBe("테스트 빌드 폴더");
    expect(openClick(row.components[0].custom_id)).toEqual({ path: "/a/Debug" });
    expect(openClick("ondra:open:gone")).toEqual({ path: undefined });
    expect(openClick("ondra:pick:x")).toBeUndefined();
  });
});
