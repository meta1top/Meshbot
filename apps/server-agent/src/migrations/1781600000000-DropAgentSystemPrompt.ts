import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Agent 编辑器 v2 第一段：人格正文从 DB 列迁到 `<agentDir>/prompts/` 文件
 * （由新的 system:prompts 消息注入，见 ContextBuilder.buildPromptsMessage）。
 * 不迁移旧数据——老 Agent 的 systemPrompt 直接丢弃，用户在提示词 tab 自己重填
 * AGENT.md。SQLite 3.35+ 支持 DROP COLUMN（与 DropSessionImCompanionFields 同例）。
 */
export class DropAgentSystemPrompt1781600000000 implements MigrationInterface {
  name = "DropAgentSystemPrompt1781600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "system_prompt"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN "system_prompt" TEXT NOT NULL DEFAULT ''`,
    );
  }
}
