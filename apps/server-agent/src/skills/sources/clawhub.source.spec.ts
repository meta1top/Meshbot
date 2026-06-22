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
  describe("list - 映射 MarketSkillSummary", () => {
    it("从 clawhub.ai 拉取并映射为 MarketSkillSummary（source='clawhub'）", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => [
          {
            slug: "my-skill",
            display_name: "My Skill",
            description: "A cool skill",
            author: "alice",
            version: "1.2.0",
            downloads: 500,
          },
        ],
      } as unknown as Response);

      const result = await source.list();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        source: "clawhub",
        ref: "my-skill",
        slug: "my-skill",
        displayName: "My Skill",
        description: "A cool skill",
        author: "alice",
        latestVersion: "1.2.0",
        downloads: 500,
      });
    });

    it("带查询参数 q 时，URL 包含 encoded q", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => [],
      } as unknown as Response);

      await source.list("file tools");

      expect(fetch).toHaveBeenCalledWith(
        "https://clawhub.ai/api/v1/skills?q=file%20tools",
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

    it("支持 { data: [] } 响应信封", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              slug: "wrapped",
              display_name: "Wrapped",
              description: "",
              author: "bob",
              version: "0.1.0",
            },
          ],
        }),
      } as unknown as Response);

      const result = await source.list();
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe("wrapped");
    });
  });

  // ── fetchPackage ──────────────────────────────────────────────────────────
  describe("fetchPackage - 不支持安装", () => {
    it("抛出 SKILL_SOURCE_UNSUPPORTED", async () => {
      await expect(source.fetchPackage("some-skill")).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.SKILL_SOURCE_UNSUPPORTED.code },
      });
    });
  });
});
