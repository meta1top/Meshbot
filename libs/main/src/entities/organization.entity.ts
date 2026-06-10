import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** 企业/组织（单层）。owner_id 与 Membership.role=owner 冗余，便于直查。 */
@Entity("organization")
export class Organization {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  name!: string;

  @Column({ type: "uuid" })
  ownerId!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
