import { BeforeInsert, PrimaryColumn } from "typeorm";
import { generateSnowflakeId } from "../utils/snowflake";

/** 所有 Entity 的雪花 ID 主键基类。@BeforeInsert 自动生成 19-20 位十进制字符串。 */
export abstract class SnowflakeBaseEntity {
  @PrimaryColumn({ type: "varchar", length: 20 })
  id!: string;

  @BeforeInsert()
  protected generateId() {
    if (!this.id) this.id = generateSnowflakeId();
  }
}
