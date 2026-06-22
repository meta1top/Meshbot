import { Repository } from "typeorm";
import type { PublishSkillInput } from "@meshbot/types-main";
import { SkillPackage } from "../entities/skill-package.entity";
import { SkillVersion } from "../entities/skill-version.entity";
import { SkillPackageService } from "./skill-package.service";

/**
 * SkillPackageService 单测。
 *
 * 测试策略：用最小手写桩替代 TypeORM Repository 和 @Transactional 装饰器。
 * @Transactional() 通过 `instanceof Repository` 检查 — 需要 Object.create(Repository.prototype)。
 */

/** 构造 passthrough QueryRunner（不真正开事务）。 */
function makeQueryRunner() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

/** 返回伪 DataSource（足够让 @Transactional 的 root 路径运行）。 */
function makeFakeDataSource() {
  return {
    createQueryRunner: () => makeQueryRunner(),
  };
}

function makePackageRepo(overrides: Record<string, jest.Mock> = {}) {
  const fakeDs = makeFakeDataSource();
  const repo = Object.assign(Object.create(Repository.prototype), {
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
    findOneBy: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest
      .fn()
      .mockImplementation((e: object) =>
        Promise.resolve({ id: "pkg-1", ...e }),
      ),
    create: jest.fn().mockImplementation((data: object) => ({ ...data })),
    increment: jest.fn().mockResolvedValue(undefined),
    manager: {
      connection: fakeDs,
    },
    ...overrides,
  });
  return repo as typeof repo;
}

function makeVersionRepo(overrides: Record<string, jest.Mock> = {}) {
  const repo = Object.assign(Object.create(Repository.prototype), {
    findOneBy: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest
      .fn()
      .mockImplementation((e: object) =>
        Promise.resolve({ id: "ver-1", ...e }),
      ),
    create: jest.fn().mockImplementation((data: object) => ({ ...data })),
    ...overrides,
  });
  return repo as typeof repo;
}

function buildSvc(
  pkgRepo: ReturnType<typeof makePackageRepo>,
  verRepo: ReturnType<typeof makeVersionRepo>,
) {
  return new SkillPackageService(pkgRepo as never, verRepo as never);
}

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
    archiveBase64: "dGFyYmFsbA==",
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as SkillPackage;
}

function makeVersion(overrides: Partial<SkillVersion> = {}): SkillVersion {
  return {
    id: "ver-1",
    packageId: "pkg-1",
    version: "1.0.0",
    assetKey: "skills/my-skill/1.0.0.zip",
    checksum: "abc123",
    sizeBytes: 1024,
    readme: "# My Skill",
    changelog: null,
    createdAt: new Date(),
    ...overrides,
  } as SkillVersion;
}

describe("SkillPackageService", () => {
  // ── list ──────────────────────────────────────────────────────────
  describe("list", () => {
    it("仅返回 public=true 的包，按 downloads desc", async () => {
      const pkgs = [
        makePkg({ downloads: 10 }),
        makePkg({ id: "pkg-2", downloads: 5 }),
      ];
      const getMany = jest.fn().mockResolvedValue(pkgs);
      const pkgRepo = makePackageRepo({
        createQueryBuilder: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany,
        }),
      });
      const svc = buildSvc(pkgRepo, makeVersionRepo());
      const result = await svc.list();
      expect(getMany).toHaveBeenCalled();
      expect(result).toHaveLength(2);
    });

    it("传入 q 时调用 andWhere 过滤", async () => {
      const andWhere = jest.fn().mockReturnThis();
      const pkgRepo = makePackageRepo({
        createQueryBuilder: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          andWhere,
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        }),
      });
      const svc = buildSvc(pkgRepo, makeVersionRepo());
      await svc.list("search-term");
      expect(andWhere).toHaveBeenCalled();
    });

    it("不传 q 时不调用 andWhere", async () => {
      const andWhere = jest.fn().mockReturnThis();
      const pkgRepo = makePackageRepo({
        createQueryBuilder: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          andWhere,
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        }),
      });
      const svc = buildSvc(pkgRepo, makeVersionRepo());
      await svc.list();
      expect(andWhere).not.toHaveBeenCalled();
    });
  });

  // ── getBySlug ─────────────────────────────────────────────────────
  describe("getBySlug", () => {
    it("slug 命中时返回包", async () => {
      const pkg = makePkg();
      const pkgRepo = makePackageRepo({
        findOneBy: jest.fn().mockResolvedValue(pkg),
      });
      const svc = buildSvc(pkgRepo, makeVersionRepo());
      const result = await svc.getBySlug("my-skill");
      expect(result).toEqual(pkg);
    });

    it("slug 未命中时返回 null", async () => {
      const svc = buildSvc(makePackageRepo(), makeVersionRepo());
      const result = await svc.getBySlug("not-exist");
      expect(result).toBeNull();
    });
  });

  // ── listVersions ─────────────────────────────────────────────────
  describe("listVersions", () => {
    it("返回包的所有版本，按 createdAt desc", async () => {
      const versions = [
        makeVersion(),
        makeVersion({ id: "ver-2", version: "0.9.0" }),
      ];
      const verRepo = makeVersionRepo({
        find: jest.fn().mockResolvedValue(versions),
      });
      const svc = buildSvc(makePackageRepo(), verRepo);
      const result = await svc.listVersions("pkg-1");
      expect(result).toHaveLength(2);
      expect(verRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { packageId: "pkg-1" } }),
      );
    });
  });

  // ── getVersion ───────────────────────────────────────────────────
  describe("getVersion", () => {
    it("命中时返回版本", async () => {
      const ver = makeVersion();
      const verRepo = makeVersionRepo({
        findOneBy: jest.fn().mockResolvedValue(ver),
      });
      const svc = buildSvc(makePackageRepo(), verRepo);
      const result = await svc.getVersion("pkg-1", "1.0.0");
      expect(result).toEqual(ver);
    });

    it("未命中时返回 null", async () => {
      const svc = buildSvc(makePackageRepo(), makeVersionRepo());
      const result = await svc.getVersion("pkg-1", "9.9.9");
      expect(result).toBeNull();
    });
  });

  // ── incrementDownloads ────────────────────────────────────────────
  describe("incrementDownloads", () => {
    it("调用 increment 将 downloads +1", async () => {
      const increment = jest.fn().mockResolvedValue(undefined);
      const pkgRepo = makePackageRepo({ increment });
      const svc = buildSvc(pkgRepo, makeVersionRepo());
      await svc.incrementDownloads("pkg-1");
      expect(increment).toHaveBeenCalledWith({ id: "pkg-1" }, "downloads", 1);
    });
  });

  // ── persistPublish ────────────────────────────────────────────────
  describe("persistPublish", () => {
    it("新包：建 skill_package 并插入 skill_version，latestVersion=version", async () => {
      const savedPkg = makePkg({ id: "pkg-new" });
      const pkgSave = jest.fn().mockResolvedValue(savedPkg);
      const pkgRepo = makePackageRepo({
        findOneBy: jest.fn().mockResolvedValue(null),
        save: pkgSave,
      });
      const verSave = jest.fn().mockResolvedValue({ id: "ver-new" });
      const verRepo = makeVersionRepo({ save: verSave });

      const svc = buildSvc(pkgRepo, verRepo);
      await svc.persistPublish(
        "user-1",
        makePublishInput(),
        "skills/my-skill/1.0.0.zip",
        "sha256abc",
        2048,
      );

      expect(pkgSave).toHaveBeenCalledTimes(1);
      const savedPkgArg = pkgSave.mock.calls[0][0] as { latestVersion: string };
      expect(savedPkgArg.latestVersion).toBe("1.0.0");

      expect(verSave).toHaveBeenCalledTimes(1);
      const savedVerArg = verSave.mock.calls[0][0] as {
        version: string;
        packageId: string;
      };
      expect(savedVerArg.version).toBe("1.0.0");
      expect(savedVerArg.packageId).toBe("pkg-new");
    });

    it("既有包：更新元数据 + 更新 latestVersion + 插入新版本", async () => {
      const existingPkg = makePkg({ latestVersion: "1.0.0" });
      const pkgSave = jest
        .fn()
        .mockResolvedValue({ ...existingPkg, latestVersion: "2.0.0" });
      const pkgRepo = makePackageRepo({
        findOneBy: jest.fn().mockResolvedValue(existingPkg),
        save: pkgSave,
      });
      const verSave = jest.fn().mockResolvedValue({ id: "ver-2" });
      const verRepo = makeVersionRepo({ save: verSave });

      const svc = buildSvc(pkgRepo, verRepo);
      await svc.persistPublish(
        "user-1",
        makePublishInput({ version: "2.0.0" }),
        "skills/my-skill/2.0.0.zip",
        "sha256def",
        3000,
      );

      // 包应被更新（save 调用时 latestVersion=2.0.0）
      expect(pkgSave).toHaveBeenCalledTimes(1);
      const updatedPkg = pkgSave.mock.calls[0][0] as { latestVersion: string };
      expect(updatedPkg.latestVersion).toBe("2.0.0");

      // 版本应被插入
      expect(verSave).toHaveBeenCalledTimes(1);
      const verArg = verSave.mock.calls[0][0] as { version: string };
      expect(verArg.version).toBe("2.0.0");
    });

    it("changelog 为 undefined 时存储为 null", async () => {
      const savedPkg = makePkg({ id: "pkg-nc" });
      const pkgRepo = makePackageRepo({
        findOneBy: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(savedPkg),
      });
      const verSave = jest.fn().mockResolvedValue({ id: "ver-nc" });
      const verRepo = makeVersionRepo({ save: verSave });

      const svc = buildSvc(pkgRepo, verRepo);
      await svc.persistPublish(
        "user-1",
        makePublishInput({ changelog: undefined }),
        "skills/my-skill/1.0.0.zip",
        "sha256",
        1000,
      );

      const verArg = verSave.mock.calls[0][0] as { changelog: unknown };
      expect(verArg.changelog).toBeNull();
    });
  });
});
