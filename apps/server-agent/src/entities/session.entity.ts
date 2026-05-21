import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** 会话表。id 同时作为 LangGraph thread_id 与 socket.io room id。 */
@Entity("sessions")
export class Session {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  title!: string;

  /** idle = 无 run 在跑；running = 有 run 在跑。 */
  @Column({ default: "idle" })
  status!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
