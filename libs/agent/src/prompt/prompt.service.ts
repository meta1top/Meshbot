import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { AccountContextService } from "../account/account-context.service";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import type { PromptMap } from "./prompt.types";

@Injectable()
export class PromptService {
  /** 每个账号独立的 prompt 缓存：cloudUserId → PromptMap。 */
  private readonly byAccount = new Map<string, PromptMap>();

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly account: AccountContextService,
  ) {}

  /** 当前账号的 prompt 目录（account-aware）。 */
  private dir(): string {
    return this.config.getPromptDir();
  }

  /**
   * 返回当前账号的 PromptMap 缓存（懒加载，首次访问时从磁盘读取）。
   * 无账号上下文时 account.getOrThrow() 抛错。
   */
  private cache(): PromptMap {
    const id = this.account.getOrThrow();
    let m = this.byAccount.get(id);
    if (!m) {
      m = this.loadFrom(this.dir());
      this.byAccount.set(id, m);
    }
    return m;
  }

  /**
   * 从指定目录扫描 .md 文件，构建 PromptMap。
   * 目录不存在时返回空 Map。
   */
  private loadFrom(dir: string): PromptMap {
    if (!existsSync(dir)) {
      return new Map();
    }

    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    const result: PromptMap = new Map();

    for (const file of files) {
      const filePath = path.join(dir, file);
      const name = path.basename(file, ".md");
      const content = readFileSync(filePath, "utf8");
      const stats = statSync(filePath);
      result.set(name, { content, mtime: stats.mtimeMs });
    }

    return result;
  }

  /**
   * 获取指定名称的 prompt 内容。
   * 当前账号无此 prompt 时返回 undefined。
   */
  getPrompt(name: string): string | undefined {
    return this.cache().get(name)?.content;
  }

  /**
   * 返回当前账号所有 prompt 的 name → content 映射。
   */
  getAllPrompts(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [name, entry] of this.cache()) {
      result.set(name, entry.content);
    }
    return result;
  }

  /**
   * 检查当前账号的 prompt 目录是否有文件变更（mtime），有则重新加载缓存。
   * 必须在账号上下文内调用。
   */
  reloadIfChanged(): void {
    const dir = this.dir();
    if (!existsSync(dir)) return;

    const id = this.account.getOrThrow();
    const current = this.byAccount.get(id) ?? new Map();
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    let hasChanges = false;

    for (const file of files) {
      const filePath = path.join(dir, file);
      const name = path.basename(file, ".md");
      const existing = current.get(name);
      const stats = statSync(filePath);

      if (!existing || existing.mtime !== stats.mtimeMs) {
        hasChanges = true;
        break;
      }
    }

    if (hasChanges || files.length !== current.size) {
      this.byAccount.set(id, this.loadFrom(dir));
    }
  }

  /**
   * 失效指定账号的 prompt 缓存（切账号 / 改配置时调用）。
   * 下次访问该账号会重新从磁盘读取。
   */
  evict(cloudUserId: string): void {
    this.byAccount.delete(cloudUserId);
  }
}
