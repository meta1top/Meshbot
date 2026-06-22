import { AgentErrorCode } from "../../errors/agent.error-codes";
import type { CloudClientService } from "../../cloud/cloud-client.service";
import type { CloudIdentityService } from "../../services/cloud-identity.service";
import type { AccountContextService } from "@meshbot/agent";
import type { ConfigService } from "@nestjs/config";
import { OurMarketSource } from "./our-market.source";

/** 构造测试用 OurMarketSource，注入 mock 依赖。 */
function makeSource(overrides?: {
  cloudGet?: jest.Mock;
  cloudPost?: jest.Mock;
  token?: string | null | undefined;
  baseUrl?: string;
}): {
  source: OurMarketSource;
  cloudGet: jest.Mock;
  cloudPost: jest.Mock;
} {
  const cloudGet = overrides?.cloudGet ?? jest.fn();
  const cloudPost = overrides?.cloudPost ?? jest.fn();

  const cloud = {
    get: cloudGet,
    post: cloudPost,
  } as unknown as CloudClientService;

  // token: undefined → use default "test-token"; token: null → simulate missing cloudToken
  const tokenValue =
    overrides && "token" in overrides ? overrides.token : "test-token";
  const identityRow =
    tokenValue === null
      ? { cloudToken: undefined }
      : { cloudToken: tokenValue };
  const identity = {
    get: jest.fn().mockResolvedValue(identityRow),
  } as unknown as CloudIdentityService;

  const account = {
    getOrThrow: jest.fn().mockReturnValue("user-123"),
  } as unknown as AccountContextService;

  const baseUrl = overrides?.baseUrl ?? "https://cloud.meshbot.test";
  const config = {
    getOrThrow: jest.fn().mockReturnValue(baseUrl),
  } as unknown as ConfigService;

  const source = new OurMarketSource(cloud, identity, account, config);
  return { source, cloudGet, cloudPost };
}

describe("OurMarketSource", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── list ──────────────────────────────────────────────────────────────────
  describe("list", () => {
    it("GET /api/skills 并映射为 MarketSkillSummary（source='ourMarket'）", async () => {
      const { source, cloudGet } = makeSource();
      cloudGet.mockResolvedValue([
        {
          slug: "my-skill",
          displayName: "My Skill",
          description: "Desc",
          author: "alice",
          latestVersion: "2.0.0",
          downloads: 100,
        },
      ]);

      const result = await source.list();

      expect(cloudGet).toHaveBeenCalledWith("/api/skills", "test-token");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        source: "ourMarket",
        ref: "my-skill",
        slug: "my-skill",
        displayName: "My Skill",
        description: "Desc",
        author: "alice",
        latestVersion: "2.0.0",
        downloads: 100,
      });
    });

    it("带 q 参数时，路径含 encoded q", async () => {
      const { source, cloudGet } = makeSource();
      cloudGet.mockResolvedValue([]);

      await source.list("search term");

      expect(cloudGet).toHaveBeenCalledWith(
        "/api/skills?q=search%20term",
        "test-token",
      );
    });

    it("无 cloudToken 时抛 AUTH_UNAUTHORIZED", async () => {
      const { source } = makeSource({ token: null });

      await expect(source.list()).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.AUTH_UNAUTHORIZED.code },
      });
    });
  });

  // ── fetchPackage ──────────────────────────────────────────────────────────
  describe("fetchPackage", () => {
    it("直接 fetch 二进制 tarball（绕过 CloudClientService JSON 解析）", async () => {
      const { source } = makeSource({
        baseUrl: "https://cloud.meshbot.test",
      });
      // 当 version 已指定时不需要 cloudGet
      const fakeBuffer = Buffer.from("fake-tarball");
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakeBuffer.buffer.slice(
            fakeBuffer.byteOffset,
            fakeBuffer.byteOffset + fakeBuffer.byteLength,
          ),
      } as unknown as Response);

      const pkg = await source.fetchPackage("my-skill", "1.0.0");

      expect(fetch).toHaveBeenCalledWith(
        "https://cloud.meshbot.test/api/skills/my-skill/1.0.0/download",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
      expect(pkg.suggestedName).toBe("my-skill");
      expect(pkg.archive).toEqual(fakeBuffer);
    });

    it("未指定 version 时，先 GET 详情取 latestVersion", async () => {
      const { source, cloudGet } = makeSource({
        baseUrl: "https://cloud.meshbot.test",
      });
      cloudGet.mockResolvedValue({ latestVersion: "3.0.0" });

      const fakeBuffer = Buffer.from("tarball-v3");
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakeBuffer.buffer.slice(
            fakeBuffer.byteOffset,
            fakeBuffer.byteOffset + fakeBuffer.byteLength,
          ),
      } as unknown as Response);

      const pkg = await source.fetchPackage("my-skill");

      expect(cloudGet).toHaveBeenCalledWith(
        "/api/skills/my-skill",
        "test-token",
      );
      expect(fetch).toHaveBeenCalledWith(
        "https://cloud.meshbot.test/api/skills/my-skill/3.0.0/download",
        expect.anything(),
      );
      expect(pkg.archive).toEqual(fakeBuffer);
    });

    it("404 → 抛 SKILL_NOT_FOUND", async () => {
      const { source, cloudGet } = makeSource();
      cloudGet.mockResolvedValue({ latestVersion: "1.0.0" });
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response);

      await expect(source.fetchPackage("missing-skill")).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.SKILL_NOT_FOUND.code },
      });
    });

    it("网络错误 → 抛 CLOUD_UNREACHABLE", async () => {
      const { source, cloudGet } = makeSource();
      cloudGet.mockResolvedValue({ latestVersion: "1.0.0" });
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(source.fetchPackage("my-skill")).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.CLOUD_UNREACHABLE.code },
      });
    });
  });
});
