import { AppError } from "@meshbot/common";
import type { AssetService } from "@meshbot/assets";
import type { PublishSkillInput } from "@meshbot/types-main";
import { MainErrorCode } from "../errors/main.error-codes";
import type { SkillPackage } from "../entities/skill-package.entity";
import type { SkillVersion } from "../entities/skill-version.entity";
import type { SkillPackageService } from "./skill-package.service";
import { SkillMarketService } from "./skill-market.service";

/**
 * SkillMarketService 单测 — mock SkillPackageService + AssetService。
 */

function makePublishInput(
  overrides: Partial<PublishSkillInput> = {},
): PublishSkillInput {
  return {
    slug: "my-skill",
    displayName: "My Skill",
    description: "A cool skill",
    version: "1.0.0",
    changelog: "Initial release",
    readme: "# My Skill\nDoes stuff.",
    tarballBase64: Buffer.from("fake-tarball-content").toString("base64"),
    ...overrides,
  };
}

function makePkg(overrides: Partial<SkillPackage> = {}): SkillPackage {
  return {
    id: "pkg-1",
    slug: "my-skill",
    displayName: "My Skill",
    description: "A cool skill",
    authorUserId: "user-1",
    latestVersion: "1.0.0",
    public: true,
    downloads: 5,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  } as SkillPackage;
}

function makeVersion(overrides: Partial<SkillVersion> = {}): SkillVersion {
  return {
    id: "ver-1",
    packageId: "pkg-1",
    version: "1.0.0",
    assetKey: "skills/my-skill/1.0.0.tar.gz",
    checksum: "sha256abc",
    sizeBytes: 1024,
    readme: "# My Skill\nDoes stuff.",
    changelog: null,
    createdAt: new Date("2024-01-01"),
    ...overrides,
  } as SkillVersion;
}

function makePackageSvc(
  overrides: Partial<Record<keyof SkillPackageService, jest.Mock>> = {},
): SkillPackageService {
  return {
    list: jest.fn().mockResolvedValue([]),
    getBySlug: jest.fn().mockResolvedValue(null),
    listVersions: jest.fn().mockResolvedValue([]),
    getVersion: jest.fn().mockResolvedValue(null),
    incrementDownloads: jest.fn().mockResolvedValue(undefined),
    persistPublish: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SkillPackageService;
}

function makeAssetSvc(
  overrides: Partial<Record<keyof AssetService, jest.Mock>> = {},
): AssetService {
  return {
    put: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(Buffer.from("")),
    getStream: jest
      .fn()
      .mockResolvedValue(require("node:stream").Readable.from([])),
    delete: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    getSignedUrl: jest.fn().mockResolvedValue("http://signed"),
    ensureBucket: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AssetService;
}

function buildSvc(
  pkgSvc: SkillPackageService,
  assetSvc: AssetService,
): SkillMarketService {
  return new SkillMarketService(pkgSvc, assetSvc);
}

describe("SkillMarketService", () => {
  // ── list ──────────────────────────────────────────────────────────
  describe("list", () => {
    it("返回 MarketSkillSummary 数组，author 为 authorUserId", async () => {
      const pkg = makePkg();
      const pkgSvc = makePackageSvc({
        list: jest.fn().mockResolvedValue([pkg]),
      });
      const svc = buildSvc(pkgSvc, makeAssetSvc());
      const result = await svc.list();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        slug: "my-skill",
        displayName: "My Skill",
        author: "user-1",
        latestVersion: "1.0.0",
        downloads: 5,
      });
    });

    it("传入 q 时透传给 SkillPackageService.list", async () => {
      const listFn = jest.fn().mockResolvedValue([]);
      const pkgSvc = makePackageSvc({ list: listFn });
      const svc = buildSvc(pkgSvc, makeAssetSvc());
      await svc.list("search-term");
      expect(listFn).toHaveBeenCalledWith("search-term");
    });
  });

  // ── detail ────────────────────────────────────────────────────────
  describe("detail", () => {
    it("包不存在时返回 null", async () => {
      const svc = buildSvc(makePackageSvc(), makeAssetSvc());
      const result = await svc.detail("not-exist");
      expect(result).toBeNull();
    });

    it("存在时返回 MarketSkillDetail（含 readme + versions）", async () => {
      const pkg = makePkg();
      const ver = makeVersion();
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(pkg),
        listVersions: jest.fn().mockResolvedValue([ver]),
      });
      const svc = buildSvc(pkgSvc, makeAssetSvc());
      const result = await svc.detail("my-skill");
      expect(result).not.toBeNull();
      expect(result?.readme).toBe("# My Skill\nDoes stuff.");
      expect(result?.versions).toHaveLength(1);
      expect(result?.versions[0].version).toBe("1.0.0");
    });

    it("无版本时 readme 为空字符串", async () => {
      const pkg = makePkg();
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(pkg),
        listVersions: jest.fn().mockResolvedValue([]),
      });
      const svc = buildSvc(pkgSvc, makeAssetSvc());
      const result = await svc.detail("my-skill");
      expect(result?.readme).toBe("");
    });
  });

  // ── download ─────────────────────────────────────────────────────
  describe("download", () => {
    it("包不存在时返回 null", async () => {
      const svc = buildSvc(makePackageSvc(), makeAssetSvc());
      const result = await svc.download("not-exist");
      expect(result).toBeNull();
    });

    it("指定版本不存在时返回 null", async () => {
      const pkg = makePkg();
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(pkg),
        getVersion: jest.fn().mockResolvedValue(null),
      });
      const svc = buildSvc(pkgSvc, makeAssetSvc());
      const result = await svc.download("my-skill", "9.9.9");
      expect(result).toBeNull();
    });

    it("下载成功：返回 stream + 正确 filename，downloads +1", async () => {
      const pkg = makePkg();
      const ver = makeVersion();
      const fakeStream = require("node:stream").Readable.from(["data"]);
      const getStream = jest.fn().mockResolvedValue(fakeStream);
      const incrementDownloads = jest.fn().mockResolvedValue(undefined);
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(pkg),
        getVersion: jest.fn().mockResolvedValue(ver),
        incrementDownloads,
      });
      const assetSvc = makeAssetSvc({ getStream });
      const svc = buildSvc(pkgSvc, assetSvc);
      const result = await svc.download("my-skill", "1.0.0");
      expect(result).not.toBeNull();
      expect(result?.filename).toBe("my-skill-1.0.0.tar.gz");
      expect(result?.stream).toBe(fakeStream);
      expect(incrementDownloads).toHaveBeenCalledWith("pkg-1");
    });

    it("缺省 version 时用 latestVersion", async () => {
      const pkg = makePkg({ latestVersion: "2.0.0" });
      const ver = makeVersion({ version: "2.0.0" });
      const getVersion = jest.fn().mockResolvedValue(ver);
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(pkg),
        getVersion,
      });
      const svc = buildSvc(pkgSvc, makeAssetSvc());
      await svc.download("my-skill");
      expect(getVersion).toHaveBeenCalledWith("pkg-1", "2.0.0");
    });
  });

  // ── publish ───────────────────────────────────────────────────────
  describe("publish", () => {
    it("新技能：上传 tarball 并持久化元数据", async () => {
      const put = jest.fn().mockResolvedValue(undefined);
      const persistPublish = jest.fn().mockResolvedValue(undefined);
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(null),
        persistPublish,
      });
      const assetSvc = makeAssetSvc({ put });
      const svc = buildSvc(pkgSvc, assetSvc);
      await svc.publish("user-1", makePublishInput());

      expect(put).toHaveBeenCalledWith(
        "skills/my-skill/1.0.0.tar.gz",
        expect.any(Buffer),
        "application/gzip",
      );
      expect(persistPublish).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ slug: "my-skill", version: "1.0.0" }),
        "skills/my-skill/1.0.0.tar.gz",
        expect.any(String), // sha256
        expect.any(Number), // sizeBytes
      );
    });

    it("同 slug 非作者发布 → 抛 SKILL_FORBIDDEN", async () => {
      const existing = makePkg({ authorUserId: "user-original" });
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(existing),
      });
      const svc = buildSvc(pkgSvc, makeAssetSvc());
      await expect(
        svc.publish("user-other", makePublishInput()),
      ).rejects.toMatchObject({
        errorCode: MainErrorCode.SKILL_FORBIDDEN,
      });
    });

    it("同 slug 原作者可以继续发布新版本", async () => {
      const existing = makePkg({ authorUserId: "user-1" });
      const persistPublish = jest.fn().mockResolvedValue(undefined);
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(existing),
        persistPublish,
      });
      const svc = buildSvc(pkgSvc, makeAssetSvc());
      await expect(
        svc.publish("user-1", makePublishInput({ version: "1.1.0" })),
      ).resolves.toBeUndefined();
      expect(persistPublish).toHaveBeenCalled();
    });

    it("assetKey 格式为 skills/<slug>/<version>.tar.gz", async () => {
      const put = jest.fn().mockResolvedValue(undefined);
      const persistPublish = jest.fn().mockResolvedValue(undefined);
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(null),
        persistPublish,
      });
      const assetSvc = makeAssetSvc({ put });
      const svc = buildSvc(pkgSvc, assetSvc);
      await svc.publish(
        "user-1",
        makePublishInput({ slug: "cool-skill", version: "3.2.1" }),
      );
      expect(put).toHaveBeenCalledWith(
        "skills/cool-skill/3.2.1.tar.gz",
        expect.any(Buffer),
        "application/gzip",
      );
    });

    it("抛 AppError SKILL_FORBIDDEN 时不调用 asset.put", async () => {
      const existing = makePkg({ authorUserId: "user-original" });
      const put = jest.fn();
      const pkgSvc = makePackageSvc({
        getBySlug: jest.fn().mockResolvedValue(existing),
      });
      const assetSvc = makeAssetSvc({ put });
      const svc = buildSvc(pkgSvc, assetSvc);
      await expect(
        svc.publish("user-other", makePublishInput()),
      ).rejects.toBeInstanceOf(AppError);
      expect(put).not.toHaveBeenCalled();
    });
  });
});
