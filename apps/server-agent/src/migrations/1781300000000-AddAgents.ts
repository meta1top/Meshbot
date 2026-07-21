import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 一设备多 Agent 地基：
 * - agents 表：Agent 元数据（人格/头像/默认模型/远程开关）
 * - sessions.agent_id：会话归属的 Agent（NOT NULL —— 存量不兼容，需先清库）
 * SQLite 限制：down 不删列/表（与既有迁移约定一致）。
 */
export class AddAgents1781300000000 implements MigrationInterface {
  name = "AddAgents1781300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agents" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "cloud_user_id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "avatar" TEXT NOT NULL,
        "description" TEXT NOT NULL DEFAULT '',
        "system_prompt" TEXT NOT NULL DEFAULT '',
        "default_model_config_id" TEXT,
        "remote_enabled" boolean NOT NULL DEFAULT (0),
        "visibility" TEXT NOT NULL DEFAULT 'private',
        "sort_order" integer NOT NULL DEFAULT (0),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_agents_cloud_user" ON "agents" ("cloud_user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "agent_id" TEXT NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sessions_agent" ON "sessions" ("agent_id")`,
    );
  }

  public async down(): Promise<void> {
    // SQLite 不支持 DROP COLUMN（旧版），保持结构（幂等，与仓库既有迁移一致）
  }
}
