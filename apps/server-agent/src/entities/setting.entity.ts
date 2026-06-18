import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, Entity, Unique } from "typeorm";

@Entity("settings")
@Unique(["cloudUserId", "key"])
export class Setting extends SnowflakeBaseEntity {
  @Column({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @Column()
  key!: string;

  @Column()
  value!: string;
}
