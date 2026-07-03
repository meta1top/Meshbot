import { SnowflakeBaseEntity } from "@meshbot/common";
import { Column, CreateDateColumn, Entity, Index } from "typeorm";

/** 注册邮箱验证码(6 位数字,10 分钟有效) */
@Entity("email_verification")
@Index("ix_email_verification_email", ["email"])
export class EmailVerification extends SnowflakeBaseEntity {
  @Column({ type: "varchar", length: 255 }) email!: string;
  @Column({ type: "varchar", length: 8 }) code!: string;
  @Column({ type: "int", default: 0 }) attempts!: number;
  @Column({ type: "timestamptz" }) expiresAt!: Date;
  @CreateDateColumn({ type: "timestamptz" }) createdAt!: Date;
}
