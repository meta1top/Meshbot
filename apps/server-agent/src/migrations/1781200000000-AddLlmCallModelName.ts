import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * llm_calls 加 model_name 列：调用时的模型配置显示名快照。
 * 云网关行的 model 列存云端配置 id，配置改名/删除后历史用量无法回显名称——
 * 落库时固化当时的显示名。历史行留 NULL（前端回退 id 解析链 + 删除兜底文案）。
 * 幂等：先查 PRAGMA 列存在即跳过。
 */
export class AddLlmCallModelName1781200000000 implements MigrationInterface {
  name = "AddLlmCallModelName1781200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const cols: Array<{ name: string }> = await queryRunner.query(
      `PRAGMA table_info("llm_calls")`,
    );
    if (cols.some((c) => c.name === "model_name")) return;
    await queryRunner.query(
      `ALTER TABLE "llm_calls" ADD COLUMN "model_name" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_calls" DROP COLUMN "model_name"`);
  }
}
