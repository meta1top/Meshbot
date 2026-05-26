import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * session_messages 加 metadata 列，存压缩占位行的元信息。
 *
 * SQLite 用 TEXT 存 JSON 字符串。默认 NULL，普通 user/assistant/tool 不写。
 * Compaction 占位行写 { kind: "compaction", removedCount, fromMessageId,
 * toMessageId }。摘要文本本身落在 content 字段，不重复进 metadata。
 */
export class AddSessionMessagesMetadata1779700000000
  implements MigrationInterface
{
  name = "AddSessionMessagesMetadata1779700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_messages" ADD COLUMN "metadata" TEXT NULL`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN；保留列即可（参考既有 AddSessionsPinnedAt 注释）
  }
}
