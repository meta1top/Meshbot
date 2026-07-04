import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * im_agent_session 加 last_appended_message_id 列（append 游标）。
 *
 * 背景：原 last_processed_message_id 是单一游标，在"run 成功但回流投递失败"时
 * 会被 process 无条件推进，导致算好的回复永久丢失且补处理不会重投（详见
 * AgentInboxService.process 的两段游标重构）。拆出 append 游标后：
 * - last_appended_message_id：该条用户消息是否已经 append 进本地 Agent 会话
 *   （防补处理重跑时把同一条消息 dup-append）。
 * - last_processed_message_id：该条用户消息的回复是否已经投递成功（原语义不变）。
 */
export class AddImAgentSessionAppendedCursor1781000000000
  implements MigrationInterface
{
  name = "AddImAgentSessionAppendedCursor1781000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "im_agent_session" ADD COLUMN "last_appended_message_id" TEXT`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // SQLite DROP COLUMN 需要重建表；保留列即可（参考 AddModelConfigContextWindow 的 down 注释）。
  }
}
