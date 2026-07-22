import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * llm_calls 加 purpose 列：旁路调用的用途标记，NULL = 普通对话轮次。
 *
 * 目前唯一取值 "compaction"（上下文压缩的 summarize 调用）。加这一列是为了让
 * `getLastBySession` 能把它排除出压缩 pre-check——summarize 要把整段待压缩历史
 * 喂给模型、input_tokens 天然接近满窗口，若滞留为「最新一行」会造成闩锁式误触发
 * （此后每次 run 白跑 snapshot，并提前压一次），直到落下普通轮次行才自愈。
 *
 * 历史行留 NULL，语义上正确（此前从未记录过压缩调用，存量全是普通轮次）。
 * 幂等：先查 PRAGMA 列存在即跳过。
 */
export class AddLlmCallPurpose1781500000000 implements MigrationInterface {
  name = "AddLlmCallPurpose1781500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const cols: Array<{ name: string }> = await queryRunner.query(
      `PRAGMA table_info("llm_calls")`,
    );
    if (cols.some((c) => c.name === "purpose")) return;
    await queryRunner.query(
      `ALTER TABLE "llm_calls" ADD COLUMN "purpose" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_calls" DROP COLUMN "purpose"`);
  }
}
