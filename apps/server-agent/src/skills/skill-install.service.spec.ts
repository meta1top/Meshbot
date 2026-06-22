import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "@meshbot/common";
import type { InstalledSkill, MarketSkillSummary } from "@meshbot/types-agent";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { packDir } from "./skill-archive";
import { SkillInstallService } from "./skill-install.service";

// ─── 工具：创建含 SKILL.md 的临时目录并打包 ─────────────────────────────────

async function buildSkillZip(opts: {
  name: string;
  description?: string;
  extra?: Array<{ path: string; content: string }>;
}): Promise<Buffer> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpSrc = path.join(os.tmpdir(), `meshbot-skillsrc-${id}`);
  await mkdir(tmpSrc, { recursive: true });

  const frontmatter = [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description ?? "测试技能"}`,
    "---",
    "",
    "# Test skill",
  ].join("\n");
  await writeFile(path.join(tmpSrc, "SKILL.md"), frontmatter, "utf8");

  for (const f of opts.extra ?? []) {
    const full = path.join(tmpSrc, f.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, f.content, "utf8");
  }

  const archive = await packDir(tmpSrc);
  await rm(tmpSrc, { recursive: true, force: true });
  return archive;
}

// ─── Mock 依赖 ────────────────────────────────────────────────────────────────

function makeGithubSource(
  overrides: Partial<{
    archive: Buffer;
    suggestedName: string;
  }> = {},
) {
  return {
    list: jest.fn().mockResolvedValue([] as MarketSkillSummary[]),
    fetchPackage: jest.fn().mockImplementation(async () => ({
      archive: overrides.archive ?? Buffer.alloc(0),
      suggestedName: overrides.suggestedName ?? "my-skill",
    })),
  };
}

function makeClawhubSource(items: MarketSkillSummary[] = []) {
  return {
    list: jest.fn().mockResolvedValue(items),
    fetchPackage: jest
      .fn()
      .mockRejectedValue(new AppError(AgentErrorCode.SKILL_SOURCE_UNSUPPORTED)),
  };
}

function makeOurMarketSource(
  items: MarketSkillSummary[] = [],
  overrides: Partial<{ archive: Buffer; suggestedName: string }> = {},
) {
  return {
    list: jest.fn().mockResolvedValue(items),
    fetchPackage: jest.fn().mockImplementation(async () => ({
      archive: overrides.archive ?? Buffer.alloc(0),
      suggestedName: overrides.suggestedName ?? "market-skill",
    })),
  };
}

function makeSkillService(
  entries: Array<{ name: string; description: string }> = [],
) {
  return {
    list: jest.fn().mockReturnValue(entries),
  };
}

function makeCloud(postResult: unknown = {}) {
  return {
    post: jest.fn().mockResolvedValue(postResult),
    get: jest.fn(),
    del: jest.fn(),
  };
}

function makeIdentity(token = "tok-test") {
  return {
    get: jest.fn().mockResolvedValue({ cloudToken: token }),
  };
}

function makeAccount(id = "user-123") {
  return {
    getOrThrow: jest.fn().mockReturnValue(id),
    get: jest.fn().mockReturnValue(id),
  };
}

// ─── 测试套件 ─────────────────────────────────────────────────────────────────

describe("SkillInstallService", () => {
  let skillsDir: string;
  let githubSource: ReturnType<typeof makeGithubSource>;
  let clawhubSource: ReturnType<typeof makeClawhubSource>;
  let ourMarketSource: ReturnType<typeof makeOurMarketSource>;
  let skillService: ReturnType<typeof makeSkillService>;
  let cloud: ReturnType<typeof makeCloud>;
  let identity: ReturnType<typeof makeIdentity>;
  let account: ReturnType<typeof makeAccount>;
  let svc: SkillInstallService;

  beforeEach(async () => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    skillsDir = path.join(os.tmpdir(), `meshbot-skills-${id}`);
    await mkdir(skillsDir, { recursive: true });

    githubSource = makeGithubSource();
    clawhubSource = makeClawhubSource();
    ourMarketSource = makeOurMarketSource();
    skillService = makeSkillService();
    cloud = makeCloud();
    identity = makeIdentity();
    account = makeAccount();

    const configSvc = { getSkillsDir: () => skillsDir };
    svc = new SkillInstallService(
      githubSource as any,
      clawhubSource as any,
      ourMarketSource as any,
      skillService as any,
      configSvc as any,
      cloud as any,
      identity as any,
      account as any,
    );
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  // ─── market ───────────────────────────────────────────────────────────────

  describe("market()", () => {
    it("github source 返回空列表", async () => {
      const result = await svc.market("github", "q");
      expect(githubSource.list).toHaveBeenCalledWith("q");
      expect(result).toEqual([]);
    });

    it("clawhub source 按 q 调用适配器", async () => {
      const items: MarketSkillSummary[] = [
        {
          source: "clawhub",
          ref: "my-skill",
          slug: "my-skill",
          displayName: "My Skill",
          description: "desc",
          author: "bob",
          latestVersion: "1.0.0",
        },
      ];
      clawhubSource = makeClawhubSource(items);
      const configSvc = { getSkillsDir: () => skillsDir };
      svc = new SkillInstallService(
        githubSource as any,
        clawhubSource as any,
        ourMarketSource as any,
        skillService as any,
        configSvc as any,
        cloud as any,
        identity as any,
        account as any,
      );
      const result = await svc.market("clawhub", "my");
      expect(clawhubSource.list).toHaveBeenCalledWith("my");
      expect(result).toEqual(items);
    });

    it("ourMarket source 转发调用", async () => {
      await svc.market("ourMarket");
      expect(ourMarketSource.list).toHaveBeenCalledWith(undefined);
    });
  });

  // ─── install ──────────────────────────────────────────────────────────────

  describe("install()", () => {
    it("github: 下载 → 解包 → 写 manifest → 返 InstalledSkill", async () => {
      const archive = await buildSkillZip({
        name: "my-skill",
        description: "A test skill",
      });
      githubSource = makeGithubSource({ archive, suggestedName: "my-skill" });
      const configSvc = { getSkillsDir: () => skillsDir };
      svc = new SkillInstallService(
        githubSource as any,
        clawhubSource as any,
        ourMarketSource as any,
        skillService as any,
        configSvc as any,
        cloud as any,
        identity as any,
        account as any,
      );

      const result = await svc.install({
        source: "github",
        ref: "owner/my-skill",
      });

      // 目录被创建
      const destDir = path.join(skillsDir, "my-skill");
      const skillMd = path.join(destDir, "SKILL.md");
      const manifestPath = path.join(destDir, ".meshbot-install.json");

      const [skillMdContent, manifestContent] = await Promise.all([
        readFile(skillMd, "utf8"),
        readFile(manifestPath, "utf8"),
      ]);

      expect(skillMdContent).toContain("name: my-skill");
      const manifest = JSON.parse(manifestContent);
      expect(manifest.source).toBe("github");
      expect(manifest.ref).toBe("owner/my-skill");
      expect(manifest.installedAt).toBeDefined();

      expect(result).toMatchObject<Partial<InstalledSkill>>({
        name: "my-skill",
        source: "github",
        ref: "owner/my-skill",
      });
    });

    it("ourMarket: 传 version 写入 manifest", async () => {
      const archive = await buildSkillZip({ name: "market-skill" });
      ourMarketSource = makeOurMarketSource([], {
        archive,
        suggestedName: "market-skill",
      });
      const configSvc = { getSkillsDir: () => skillsDir };
      svc = new SkillInstallService(
        githubSource as any,
        clawhubSource as any,
        ourMarketSource as any,
        skillService as any,
        configSvc as any,
        cloud as any,
        identity as any,
        account as any,
      );

      const result = await svc.install({
        source: "ourMarket",
        ref: "market-skill",
        version: "2.3.1",
      });

      const manifestPath = path.join(
        skillsDir,
        "market-skill",
        ".meshbot-install.json",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.version).toBe("2.3.1");
      expect(result.version).toBe("2.3.1");
    });

    it("解包后没有 SKILL.md → 抛 SKILL_INSTALL_FAILED", async () => {
      // 打包一个不含 SKILL.md 的目录
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const tmpSrc = path.join(os.tmpdir(), `meshbot-bad-${id}`);
      await mkdir(tmpSrc, { recursive: true });
      await writeFile(path.join(tmpSrc, "README.md"), "no skill here", "utf8");
      const archive = await packDir(tmpSrc);
      await rm(tmpSrc, { recursive: true, force: true });

      githubSource = makeGithubSource({ archive, suggestedName: "bad-skill" });
      const configSvc = { getSkillsDir: () => skillsDir };
      svc = new SkillInstallService(
        githubSource as any,
        clawhubSource as any,
        ourMarketSource as any,
        skillService as any,
        configSvc as any,
        cloud as any,
        identity as any,
        account as any,
      );

      await expect(
        svc.install({ source: "github", ref: "owner/bad" }),
      ).rejects.toThrow(AppError);

      await expect(
        svc.install({ source: "github", ref: "owner/bad" }),
      ).rejects.toMatchObject({
        errorCode: { code: AgentErrorCode.SKILL_INSTALL_FAILED.code },
      });
    });
  });

  // ─── uninstall ────────────────────────────────────────────────────────────

  describe("uninstall()", () => {
    it("删除已存在的技能目录", async () => {
      const skillDir = path.join(skillsDir, "my-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: my-skill\n---\n",
        "utf8",
      );

      await svc.uninstall("my-skill");

      // 目录不存在
      await expect(
        readFile(path.join(skillDir, "SKILL.md"), "utf8"),
      ).rejects.toThrow();
    });

    it("技能不存在时幂等不抛出", async () => {
      await expect(svc.uninstall("nonexistent")).resolves.toBeUndefined();
    });
  });

  // ─── listInstalled ────────────────────────────────────────────────────────

  describe("listInstalled()", () => {
    it("合并 SkillService.list 结果与 .meshbot-install.json manifest", async () => {
      // 先安装一个技能
      const archive = await buildSkillZip({
        name: "list-skill",
        description: "描述",
      });
      githubSource = makeGithubSource({ archive, suggestedName: "list-skill" });
      skillService = makeSkillService([
        { name: "list-skill", description: "描述" },
      ]);
      const configSvc = { getSkillsDir: () => skillsDir };
      svc = new SkillInstallService(
        githubSource as any,
        clawhubSource as any,
        ourMarketSource as any,
        skillService as any,
        configSvc as any,
        cloud as any,
        identity as any,
        account as any,
      );

      // 写 manifest
      const skillDir = path.join(skillsDir, "list-skill");
      await mkdir(skillDir, { recursive: true });
      const manifest = {
        source: "github",
        ref: "owner/list-skill",
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00.000Z",
      };
      await writeFile(
        path.join(skillDir, ".meshbot-install.json"),
        JSON.stringify(manifest),
        "utf8",
      );

      const result = await svc.listInstalled();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject<Partial<InstalledSkill>>({
        name: "list-skill",
        description: "描述",
        source: "github",
        ref: "owner/list-skill",
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00.000Z",
      });
    });

    it("没有 manifest 时 source/ref/version/installedAt 为 null", async () => {
      skillService = makeSkillService([
        { name: "bare-skill", description: "裸技能" },
      ]);
      const configSvc = { getSkillsDir: () => skillsDir };
      svc = new SkillInstallService(
        githubSource as any,
        clawhubSource as any,
        ourMarketSource as any,
        skillService as any,
        configSvc as any,
        cloud as any,
        identity as any,
        account as any,
      );

      const result = await svc.listInstalled();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject<Partial<InstalledSkill>>({
        name: "bare-skill",
        source: null,
        ref: null,
        version: null,
        installedAt: null,
      });
    });
  });

  // ─── publish ──────────────────────────────────────────────────────────────

  describe("publish()", () => {
    it("打包 → 读 SKILL.md → post 到 server-main", async () => {
      const skillDir = path.join(skillsDir, "pub-skill");
      await mkdir(skillDir, { recursive: true });
      const skillMdContent = [
        "---",
        "name: pub-skill",
        "description: 发布测试",
        "---",
        "",
        "# Publish test",
      ].join("\n");
      await writeFile(path.join(skillDir, "SKILL.md"), skillMdContent, "utf8");
      await writeFile(
        path.join(skillDir, "prompt.md"),
        "you are a skill",
        "utf8",
      );

      await svc.publish({
        name: "pub-skill",
        slug: "pub-skill",
        displayName: "Pub Skill",
        version: "1.2.3",
        changelog: "初始版本",
      });

      expect(cloud.post).toHaveBeenCalledWith(
        "/api/skills",
        expect.objectContaining({
          slug: "pub-skill",
          displayName: "Pub Skill",
          version: "1.2.3",
          changelog: "初始版本",
          readme: expect.stringContaining("pub-skill") as string,
          archiveBase64: expect.any(String) as string,
        }),
        "tok-test",
      );

      // archiveBase64 是 base64 字符串
      const body = (cloud.post as jest.Mock).mock.calls[0][1] as {
        archiveBase64: string;
      };
      expect(() => Buffer.from(body.archiveBase64, "base64")).not.toThrow();
    });

    it("description 可选字段正确传递", async () => {
      const skillDir = path.join(skillsDir, "pub2-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: pub2-skill\n---\n",
        "utf8",
      );

      await svc.publish({
        name: "pub2-skill",
        slug: "pub2-skill",
        displayName: "Pub2",
        version: "0.1.0",
      });

      expect(cloud.post).toHaveBeenCalledWith(
        "/api/skills",
        expect.objectContaining({
          slug: "pub2-skill",
          version: "0.1.0",
        }),
        "tok-test",
      );
      // changelog 未传，body 中不应有非 undefined 的 changelog
      const body = (cloud.post as jest.Mock).mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(body.changelog).toBeUndefined();
    });
  });
});
