import { AgentErrorCode } from "../../errors/agent.error-codes";
import { ClawhubSource } from "./clawhub.source";

describe("ClawhubSource", () => {
  let source: ClawhubSource;

  beforeEach(() => {
    source = new ClawhubSource();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── list ──────────────────────────────────────────────────────────────────
  // 真实 clawhub.ai API（2026-06 抓取）：
  // - 搜索 GET /api/v1/search?q= → { results: [{ slug, displayName, summary,
  //   version, downloads, ownerHandle, owner:{handle} }] }（带 score 排序）
  // - 浏览 GET /api/v1/skills    → { items: [{ slug, displayName, summary,
  //   description, tags:{latest}, stats:{downloads}, latestVersion:{version} }],
  //   nextCursor }
  // 两端字段形状不同：camelCase + 嵌套，且 author/version/downloads 取处各异。
  describe("list - 映射 MarketSkillSummary", () => {
    it("search 响应 {results:[…]}：displayName/summary/ownerHandle/扁平 downloads", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              score: 4.09,
              slug: "chrome",
              displayName: "Chrome",
              summary: "Chrome DevTools Protocol and automation patterns.",
              version: null,
              downloads: 4939,
              updatedAt: 1778486238781,
              ownerHandle: "ivangdavila",
              owner: { handle: "ivangdavila", displayName: "Iván" },
            },
          ],
        }),
      } as unknown as Response);

      const result = await source.list("chrome");

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        source: "clawhub",
        ref: "chrome",
        slug: "chrome",
        displayName: "Chrome",
        description: "Chrome DevTools Protocol and automation patterns.",
        author: "ivangdavila",
        downloads: 4939,
        // 搜索响应 version 为 null、无 latestVersion/tags → 版本未知用空串
        //（前端据此隐藏 vX 徽章，安装时空版本回退「下载最新」），不再误显 v0.0.0。
        latestVersion: "",
      });
    });

    it("browse 响应 {items:[…]}：summary 作描述、stats.downloads、latestVersion.version", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              slug: "ai-woodworking",
              displayName: "Ai Woodworking",
              summary: "AI 木工制作指南。",
              description: null,
              tags: { latest: "1.0.1" },
              stats: { downloads: 62, stars: 0 },
              latestVersion: { version: "1.0.0", license: "MIT-0" },
            },
          ],
          nextCursor: "abc",
        }),
      } as unknown as Response);

      const result = await source.list();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        source: "clawhub",
        ref: "ai-woodworking",
        slug: "ai-woodworking",
        displayName: "Ai Woodworking",
        description: "AI 木工制作指南。",
        latestVersion: "1.0.0",
        downloads: 62,
      });
    });

    it("带查询参数 q 时，URL 包含 encoded q", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      } as unknown as Response);

      await source.list("file tools");

      expect(fetch).toHaveBeenCalledWith(
        "https://clawhub.ai/api/v1/search?q=file%20tools",
      );
    });

    it("API 不可用时返回 []（网络异常降级）", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("network error"));
      expect(await source.list()).toEqual([]);
    });

    it("非 200 响应时返回 []", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 503,
      } as unknown as Response);
      expect(await source.list()).toEqual([]);
    });
  });

  // ── fetchPackage ──────────────────────────────────────────────────────────
  describe("fetchPackage - 下载 zip", () => {
    it("GET /api/v1/download?slug= 返回 zip → archive Buffer + suggestedName", async () => {
      const zipBytes = Buffer.from("PKfake-zip");
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          zipBytes.buffer.slice(
            zipBytes.byteOffset,
            zipBytes.byteOffset + zipBytes.byteLength,
          ),
      } as unknown as Response);

      const pkg = await source.fetchPackage("my-skill", "1.0.0");

      expect(fetch).toHaveBeenCalledWith(
        new URL(
          "https://clawhub.ai/api/v1/download?slug=my-skill&version=1.0.0",
        ),
      );
      expect(pkg.suggestedName).toBe("my-skill");
      expect(Buffer.isBuffer(pkg.archive)).toBe(true);
    });

    it("非 200 → 抛 SKILL_INSTALL_FAILED", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response);

      await expect(source.fetchPackage("missing")).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.SKILL_INSTALL_FAILED.code },
      });
    });
  });
});
