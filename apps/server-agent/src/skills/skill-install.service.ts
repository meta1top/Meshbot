import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@meshbot/common";
import type {
  InstalledSkill,
  InstallSkillInput,
  MarketSkillSummary,
  PublishLocalSkillInput,
  SkillInstallSource,
} from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import type {
  AccountContextService,
  MeshbotConfigService,
  SkillService,
} from "@meshbot/agent";
import { AgentErrorCode } from "../errors/agent.error-codes";
import type { CloudClientService } from "../cloud/cloud-client.service";
import type { CloudIdentityService } from "../services/cloud-identity.service";
import { extractToDir, findSkillRoot, packDir } from "./skill-archive";
import type { SkillSourceAdapter } from "./sources/skill-source";
import type { GithubSource } from "./sources/github.source";
import type { ClawhubSource } from "./sources/clawhub.source";
import type { OurMarketSource } from "./sources/our-market.source";

/** 写入 `<skillDir>/.meshbot-install.json` 的清单结构。 */
interface InstallManifest {
  source: SkillInstallSource;
  ref: string;
  version: string | null;
  installedAt: string;
}

/**
 * SkillInstallService —— 技能安装/卸载/发布编排器。
 *
 * - `market`：按 source 代理到对应适配器，返回市场技能摘要列表。
 * - `install`：下载 tarball → 安全解包到 `<skillsDir>/<name>/` → 校验含 SKILL.md
 *              → 写 `.meshbot-install.json` 清单 → 返 InstalledSkill。
 * - `uninstall`：rm -rf `<skillsDir>/<name>`（不存在幂等）。
 * - `listInstalled`：复用 SkillService.list() + 读各目录 .meshbot-install.json。
 * - `publish`：packDir → base64 → 读 SKILL.md → POST server-main /api/skills。
 */
@Injectable()
export class SkillInstallService {
  constructor(
    private readonly github: GithubSource,
    private readonly clawhub: ClawhubSource,
    private readonly ourMarket: OurMarketSource,
    private readonly skillService: SkillService,
    private readonly config: MeshbotConfigService,
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
  ) {}

  /**
   * 按 source 检索/浏览市场技能列表。
   *
   * @param source 技能来源（ourMarket / github / clawhub）
   * @param q 搜索关键词（可选）
   */
  async market(
    source: SkillInstallSource,
    q?: string,
  ): Promise<MarketSkillSummary[]> {
    return this.adapterFor(source).list(q);
  }

  /**
   * 安装技能：下载 tarball → 解包 → 校验 SKILL.md → 写清单 → 返 InstalledSkill。
   *
   * 技能名优先取 tarball 中含 SKILL.md 的子目录名（如 GitHub 格式 `<repo>-<ref>/`），
   * 退而取适配器返回的 suggestedName。
   */
  async install(input: InstallSkillInput): Promise<InstalledSkill> {
    const adapter = this.adapterFor(input.source);
    const pkg = await adapter.fetchPackage(input.ref, input.version);

    // 确定技能名称：findSkillRoot 返回含 SKILL.md 的子目录名
    const skillRoot = await findSkillRoot(pkg.archive);
    // skillRoot === "." → tarball 根即技能根，name 取 suggestedName
    // skillRoot === "<dir>" → 子目录即技能根，name 取该目录名
    const skillName =
      skillRoot && skillRoot !== "." ? skillRoot : pkg.suggestedName;

    const skillsDir = this.config.getSkillsDir();
    const destDir = path.join(skillsDir, skillName);

    // 安全解包（extractToDir 内部做路径穿越校验）
    await extractToDir(pkg.archive, destDir);

    // 如果技能根是子目录，需要把子目录内容提升到 destDir
    // extractToDir 已解包到 destDir，对于 GitHub tar 而言顶层会有 <repo>-<ref>/ 子目录
    // 调整：若 skillRoot 是子目录名，解包后其内容在 destDir/<skillRoot>/ 下
    if (skillRoot && skillRoot !== ".") {
      const subDir = path.join(destDir, skillRoot);
      if (existsSync(subDir)) {
        // 把子目录内容提升到 destDir：先提升再删除子目录
        await this.hoistSubDir(subDir, destDir);
      }
    }

    // 校验目标目录包含 SKILL.md
    const skillMdPath = path.join(destDir, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      // 安装失败：清理不完整目录
      await rm(destDir, { recursive: true, force: true });
      throw new AppError(AgentErrorCode.SKILL_INSTALL_FAILED);
    }

    // 读取 SKILL.md 取 description
    const skillMdContent = await readFile(skillMdPath, "utf8");
    const description =
      parseFrontmatterField(skillMdContent, "description") ?? "";

    // 写 .meshbot-install.json 清单
    const manifest: InstallManifest = {
      source: input.source,
      ref: input.ref,
      version: input.version ?? null,
      installedAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(destDir, ".meshbot-install.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    return {
      name: skillName,
      description,
      source: input.source,
      ref: input.ref,
      version: input.version ?? null,
      installedAt: manifest.installedAt,
    };
  }

  /**
   * 卸载技能：rm -rf `<skillsDir>/<name>`（不存在时幂等）。
   *
   * @param name 技能目录名
   */
  async uninstall(name: string): Promise<void> {
    const skillsDir = this.config.getSkillsDir();
    const destDir = path.join(skillsDir, name);
    await rm(destDir, { recursive: true, force: true });
  }

  /**
   * 列出已安装技能：复用 SkillService.list()（扫磁盘），
   * 再读各目录的 `.meshbot-install.json` 补充 source/ref/version/installedAt。
   */
  async listInstalled(): Promise<InstalledSkill[]> {
    const skillsDir = this.config.getSkillsDir();
    const entries = this.skillService.list();

    return Promise.all(
      entries.map(async (entry) => {
        const manifestPath = path.join(
          skillsDir,
          entry.name,
          ".meshbot-install.json",
        );
        let manifest: InstallManifest | null = null;
        try {
          const raw = await readFile(manifestPath, "utf8");
          manifest = JSON.parse(raw) as InstallManifest;
        } catch {
          // manifest 不存在或解析失败 → 手动安装技能，source 等字段为 null
        }
        return {
          name: entry.name,
          description: entry.description,
          source: manifest?.source ?? null,
          ref: manifest?.ref ?? null,
          version: manifest?.version ?? null,
          installedAt: manifest?.installedAt ?? null,
        } satisfies InstalledSkill;
      }),
    );
  }

  /**
   * 发布本地技能到 server-main。
   *
   * 步骤：packDir → base64 → 读 SKILL.md 文本作 readme → POST /api/skills。
   */
  async publish(input: PublishLocalSkillInput): Promise<void> {
    const skillsDir = this.config.getSkillsDir();
    const skillDir = path.join(skillsDir, input.name);

    // 打包技能目录（zip）
    const archive = await packDir(skillDir);
    const archiveBase64 = archive.toString("base64");

    // 读 SKILL.md 作 readme
    const skillMdPath = path.join(skillDir, "SKILL.md");
    let readme = "";
    try {
      readme = await readFile(skillMdPath, "utf8");
    } catch {
      // SKILL.md 不存在则 readme 为空字符串
    }

    // 获取 cloud token
    const token = await this.token();

    // 构造发布 body
    const body: Record<string, unknown> = {
      slug: input.slug,
      displayName: input.displayName,
      version: input.version,
      readme,
      archiveBase64,
    };
    if (input.changelog !== undefined) {
      body.changelog = input.changelog;
    }

    await this.cloud.post("/api/skills", body, token);
  }

  /** 按 source 返回对应适配器。 */
  private adapterFor(source: SkillInstallSource): SkillSourceAdapter {
    switch (source) {
      case "github":
        return this.github;
      case "clawhub":
        return this.clawhub;
      case "ourMarket":
        return this.ourMarket;
    }
  }

  /** 获取当前账号的 cloud token。 */
  private async token(): Promise<string> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id?.cloudToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    return id.cloudToken;
  }

  /**
   * 将子目录内容提升到父目录（子目录同名项覆盖父目录项），然后删除子目录。
   * 用于 GitHub tar 的 `<repo>-<ref>/` 子目录提升场景。
   */
  private async hoistSubDir(subDir: string, destDir: string): Promise<void> {
    const { cp } = await import("node:fs/promises");
    // 将 subDir 内容复制到 destDir（覆盖）
    await cp(subDir, destDir, { recursive: true, force: true });
    // 删除子目录
    await rm(subDir, { recursive: true, force: true });
  }
}

/**
 * 从 SKILL.md frontmatter 取单个字段值（容错）。
 */
function parseFrontmatterField(raw: string, field: string): string | undefined {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) return undefined;
  const block = fmMatch[1];
  for (const line of block.split("\n")) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv || kv[1] !== field) continue;
    let value = kv[2].trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    return value;
  }
  return undefined;
}
