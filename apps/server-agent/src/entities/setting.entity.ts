import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("settings")
export class Setting {
  @PrimaryColumn({ name: "cloud_user_id", type: "text" })
  cloudUserId!: string;

  @PrimaryColumn()
  key!: string;

  @Column()
  value!: string;
}
