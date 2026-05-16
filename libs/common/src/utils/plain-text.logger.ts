import { Logger as NestLogger } from "@nestjs/common";
import type { Logger as TypeOrmLogger } from "typeorm";

/**
 * TypeORM 纯文本日志 —— Phase 5 Track C2。
 *
 * NestJS 默认 logger 输出带 ANSI 颜色，在容器 / aggregator（如 Datadog / Loki）
 * 中显示为乱码。本 logger 输出纯 ASCII，按级别走 NestLogger 接口（仍可被 Nest
 * 的全局 logger 接管 / 格式化）。
 *
 * 标签：
 * - `[QUERY]` 普通 SQL
 * - `[SLOW QUERY]` 超 `slowThresholdMs`（默认 500ms）的查询
 * - `[QUERY ERROR]` 失败查询（含异常信息）
 * - `[SCHEMA]` schema build 输出
 * - `[MIGRATION]` 迁移输出
 *
 * 用法（server-* `app.module.ts`）：
 * ```ts
 * TypeOrmModule.forRoot({
 *   ...
 *   logging: ["error", "warn", "migration"],
 *   logger: new PlainTextLogger(),
 * })
 * ```
 *
 * 生产 / 容器环境推荐启用；本地开发保留 Nest 默认 colored 调试更方便。
 */
export class PlainTextLogger implements TypeOrmLogger {
  private readonly logger = new NestLogger("TypeORM");

  constructor(private readonly slowThresholdMs = 500) {}

  logQuery(query: string, parameters?: unknown[]) {
    this.logger.debug(`[QUERY] ${this.format(query, parameters)}`);
  }

  logQueryError(error: string | Error, query: string, parameters?: unknown[]) {
    const msg = error instanceof Error ? error.message : error;
    this.logger.error(
      `[QUERY ERROR] ${msg} | sql=${this.format(query, parameters)}`,
    );
  }

  logQuerySlow(time: number, query: string, parameters?: unknown[]) {
    this.logger.warn(
      `[SLOW QUERY ${time}ms] ${this.format(query, parameters)}`,
    );
  }

  logSchemaBuild(message: string) {
    this.logger.log(`[SCHEMA] ${message}`);
  }

  logMigration(message: string) {
    this.logger.log(`[MIGRATION] ${message}`);
  }

  log(level: "log" | "info" | "warn", message: unknown) {
    const text = typeof message === "string" ? message : String(message);
    if (level === "warn") this.logger.warn(text);
    else this.logger.log(text);
  }

  private format(query: string, parameters?: unknown[]): string {
    const oneLine = query.replace(/\s+/g, " ").trim();
    if (!parameters || parameters.length === 0) return oneLine;
    return `${oneLine} -- params=${this.safeJson(parameters)}`;
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  /** Threshold（毫秒）用于判定 slow query —— 暴露给 TypeORM 配置参考。 */
  getSlowThreshold(): number {
    return this.slowThresholdMs;
  }
}
