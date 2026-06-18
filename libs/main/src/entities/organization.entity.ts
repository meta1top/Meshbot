import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, UpdateDateColumn } from "typeorm";

/** 企业/组织（单层）。ownerId 与 Membership.role=owner 冗余，便于直查。 */
@Entity("organization")
export class Organization extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 64 })
  name!: string;

  @Column({ type: "varchar", length: 20 })
  ownerId!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
