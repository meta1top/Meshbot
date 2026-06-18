// scripts/check-pk.spec.ts
import { runPkCheck } from "./check-pk";

const SNOWFLAKE_BASE = `
  import { BeforeInsert, PrimaryColumn } from "typeorm";
  import { generateSnowflakeId } from "../utils/snowflake";
  export abstract class SnowflakeBaseEntity {
    @PrimaryColumn({ type: "varchar", length: 20 }) id!: string;
    @BeforeInsert() protected generateId() { if (!this.id) this.id = generateSnowflakeId(); }
  }
`;

const GOOD_ENTITY = `
  import { SnowflakeBaseEntity } from "@meshbot/common";
  import { Column, Entity } from "typeorm";
  @Entity("sessions")
  export class Session extends SnowflakeBaseEntity {
    @Column() title!: string;
  }
`;

const UUID_ENTITY = `
  import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
  @Entity("sessions")
  export class Session {
    @PrimaryGeneratedColumn("uuid") id!: string;
    @Column() title!: string;
  }
`;

const MISSING_EXTENDS = `
  import { Column, Entity } from "typeorm";
  @Entity("sessions")
  export class Session {
    @Column() title!: string;
  }
`;

const BARE_PRIMARY_COLUMN = `
  import { Column, Entity, PrimaryColumn } from "typeorm";
  @Entity("sessions")
  export class Session {
    @PrimaryColumn() id!: string;
    @Column() title!: string;
  }
`;

describe("runPkCheck", () => {
  it("合规 entity → 无违规", () => {
    const v = runPkCheck({
      "snowflake-base.entity.ts": SNOWFLAKE_BASE,
      "session.entity.ts": GOOD_ENTITY,
    });
    expect(v).toHaveLength(0);
  });

  it("snowflake-base.entity.ts 自身被跳过", () => {
    const v = runPkCheck({ "snowflake-base.entity.ts": SNOWFLAKE_BASE });
    expect(v).toHaveLength(0);
  });

  it("@PrimaryGeneratedColumn → LEGACY_PRIMARY 违规", () => {
    const v = runPkCheck({ "session.entity.ts": UUID_ENTITY });
    expect(v.some((x) => x.reason.includes("PrimaryGeneratedColumn"))).toBe(
      true,
    );
  });

  it("缺少 extends SnowflakeBaseEntity → MISSING_BASE 违规", () => {
    const v = runPkCheck({ "session.entity.ts": MISSING_EXTENDS });
    expect(
      v.some((x) => x.reason.includes("缺少 extends SnowflakeBaseEntity")),
    ).toBe(true);
  });

  it("裸 @PrimaryColumn → LEGACY_PRIMARY 违规", () => {
    const v = runPkCheck({ "session.entity.ts": BARE_PRIMARY_COLUMN });
    expect(v.some((x) => x.reason.includes("@PrimaryColumn"))).toBe(true);
  });

  it("非 .entity.ts 文件被跳过", () => {
    const v = runPkCheck({
      "session.service.ts": `@Entity("sessions") export class Session { @PrimaryGeneratedColumn("uuid") id!: string; }`,
    });
    expect(v).toHaveLength(0);
  });
});
