import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 移除 Agent-DM 反向通道的 schema 与数据：
 * 清 kind='im-agent' 会话及其关联（session_messages/pending_messages/llm_calls）
 * → 删 im_agent_session 映射表。与移除 AgentInbox/ImAgentSession 代码配套。
 * 幂等：DROP TABLE IF EXISTS；DELETE 无匹配即 no-op（fresh 库亦安全）。
 */
export class DropImAgentSession1781100000000 implements MigrationInterface {
  name = "DropImAgentSession1781100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const t of ["session_messages", "pending_messages", "llm_calls"]) {
      await queryRunner.query(
        `DELETE FROM "${t}" WHERE "session_id" IN (SELECT "id" FROM "sessions" WHERE "kind" = 'im-agent')`,
      );
    }
    await queryRunner.query(`DELETE FROM "sessions" WHERE "kind" = 'im-agent'`);
    await queryRunner.query(`DROP TABLE IF EXISTS "im_agent_session"`);
  }

  public async down(): Promise<void> {
    // 单向移除，不恢复 im_agent_session 表与 im-agent 会话
  }
}
