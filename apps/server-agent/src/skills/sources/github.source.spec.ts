import { zipSync } from "fflate";
import { GithubSource } from "./github.source";

/** 合法的空 zip（无 SKILL.md）。 */
const makeEmptyZip = (): Buffer => Buffer.from(zipSync({}));

describe("GithubSource", () => {
  let source: GithubSource;

  beforeEach(() => {
    source = new GithubSource();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── list ──────────────────────────────────────────────────────────────────
  describe("list", () => {
    it("始终返回空数组（GitHub 无预检索端点）", async () => {
      expect(await source.list()).toEqual([]);
      expect(await source.list("some query")).toEqual([]);
    });
  });

  // ── fetchPackage ref 解析 ─────────────────────────────────────────────────
  describe("fetchPackage - ref 解析", () => {
    const fakeTarGz = Buffer.from("fake-tar-content");

    function mockFetchOk(): void {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeTarGz.buffer,
      } as unknown as Response);
    }

    it("owner/repo（无 @ref）→ 请求 HEAD", async () => {
      mockFetchOk();
      await source.fetchPackage("myowner/myrepo").catch(() => {});
      expect(fetch).toHaveBeenCalledWith(
        "https://codeload.github.com/myowner/myrepo/zip/HEAD",
      );
    });

    it("owner/repo@main → 请求 main 分支", async () => {
      mockFetchOk();
      await source.fetchPackage("myowner/myrepo@main").catch(() => {});
      expect(fetch).toHaveBeenCalledWith(
        "https://codeload.github.com/myowner/myrepo/zip/main",
      );
    });

    it("owner/repo@v1.0.0 → 请求 tag v1.0.0", async () => {
      mockFetchOk();
      await source.fetchPackage("myowner/myrepo@v1.0.0").catch(() => {});
      expect(fetch).toHaveBeenCalledWith(
        "https://codeload.github.com/myowner/myrepo/zip/v1.0.0",
      );
    });

    it("fetch 失败（非 200）→ 抛出 Error", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response);

      await expect(source.fetchPackage("owner/repo")).rejects.toThrow();
    });

    it("suggestedName 取 repo 名（无 SKILL.md 时）", async () => {
      // 合法的空 zip，不含 SKILL.md
      const emptyZip = makeEmptyZip();

      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          emptyZip.buffer.slice(
            emptyZip.byteOffset,
            emptyZip.byteOffset + emptyZip.byteLength,
          ),
      } as unknown as Response);

      const pkg = await source.fetchPackage("myowner/myrepo");
      expect(pkg.suggestedName).toBe("myrepo");
    });
  });
});
