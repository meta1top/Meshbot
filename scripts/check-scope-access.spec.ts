import { runScopeCheck } from "./check-scope-access";

/** 账号作用域 Entity 固件：带 `cloud_user_id` 列 → 属作用域表。 */
const SCOPED = `import {Entity,Column,PrimaryColumn} from "typeorm"; @Entity("sessions") export class Session { @PrimaryColumn() id!: string; @Column({name:"cloud_user_id"}) cloudUserId!: string; }`;

describe("runScopeCheck", () => {
  it("裸 repo.find 直接调用 → 违规", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class SessionService { constructor(@InjectRepository(Session) private repo: Repository<Session>){} list(){ return this.repo.find(); } }`,
    });
    expect(f.some((x) => x.type === "UNSCOPED_QUERY")).toBe(true);
  });

  it("repo 仅传入工厂、查询走 scoped 字段 → 合规", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class SessionService { private repo; constructor(@InjectRepository(Session) raw: Repository<Session>, f: any){ this.repo = f.create(raw); } list(){ return this.repo.find(); } }`,
    });
    expect(f.length).toBe(0);
  });

  it("CloudIdentity 裸 repo 不报（账号注册表本身豁免）", () => {
    const f = runScopeCheck({
      "cloud-identity.entity.ts": `import {Entity,PrimaryColumn} from "typeorm"; @Entity("cloud_identity") export class CloudIdentity { @PrimaryColumn({name:"cloud_user_id"}) cloudUserId!: string; }`,
      "cloud-identity.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class CloudIdentityService { constructor(@InjectRepository(CloudIdentity) private repo: Repository<CloudIdentity>){} get(id: string){ return this.repo.findOneBy({cloudUserId: id}); } }`,
    });
    expect(f.length).toBe(0);
  });

  it("allow-unscoped 注释豁免该行", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class SessionService { constructor(@InjectRepository(Session) private repo: Repository<Session>){} reset(){ // scope-check: allow-unscoped\n return this.repo.update({status:"x"},{status:"y"}); } }`,
    });
    expect(f.length).toBe(0);
  });

  it(".unscoped() 链不算裸 repo（ScopedRepository 的逃逸出口）", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `import {Injectable} from "@nestjs/common"; @Injectable() export class SessionService { private repo:any; boot(){ return this.repo.unscoped().find(); } }`,
    });
    expect(f.length).toBe(0);
  });

  // ── 额外覆盖：检测精度边界 ──

  it("裸 repo 直接赋给字段后再查询（tx-anchor 误用）→ 违规", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class SessionService { private anchor: Repository<Session>; constructor(@InjectRepository(Session) raw: Repository<Session>){ this.anchor = raw; } list(){ return this.anchor.find(); } }`,
    });
    expect(f.some((x) => x.type === "UNSCOPED_QUERY")).toBe(true);
  });

  it("裸 repo 仅作 tx-anchor 字段、从不查询 → 合规", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class SessionService { private readonly scoped; private readonly txAnchor: Repository<Session>; constructor(@InjectRepository(Session) raw: Repository<Session>, f: any){ this.scoped = f.create(raw); this.txAnchor = raw; } list(){ return this.scoped.find(); } }`,
    });
    expect(f.length).toBe(0);
  });

  it("非作用域 Entity（无 cloud_user_id）裸 repo 查询 → 合规", () => {
    const f = runScopeCheck({
      "foo.entity.ts": `import {Entity,PrimaryColumn,Column} from "typeorm"; @Entity("foos") export class Foo { @PrimaryColumn() id!: string; @Column() name!: string; }`,
      "foo.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class FooService { constructor(@InjectRepository(Foo) private repo: Repository<Foo>){} list(){ return this.repo.find(); } }`,
    });
    expect(f.length).toBe(0);
  });

  it("裸 repo.createQueryBuilder / save / delete 等也算违规", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class SessionService { constructor(@InjectRepository(Session) private repo: Repository<Session>){} a(){ return this.repo.createQueryBuilder("s").getMany(); } b(){ return this.repo.save({} as any); } c(){ return this.repo.delete({}); } }`,
    });
    expect(f.filter((x) => x.type === "UNSCOPED_QUERY").length).toBe(3);
  });

  it("文件级 scope-check: ignore-file 跳过整个文件", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `// scope-check: ignore-file\nimport {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class SessionService { constructor(@InjectRepository(Session) private repo: Repository<Session>){} list(){ return this.repo.find(); } }`,
    });
    expect(f.length).toBe(0);
  });

  it("findData：违规 finding 形状字段齐全", () => {
    const f = runScopeCheck({
      "session.entity.ts": SCOPED,
      "session.service.ts": `import {Injectable} from "@nestjs/common"; import {InjectRepository} from "@nestjs/typeorm"; import {Repository} from "typeorm"; @Injectable() export class SessionService { constructor(@InjectRepository(Session) private repo: Repository<Session>){} list(){ return this.repo.find(); } }`,
    });
    const issue = f.find((x) => x.type === "UNSCOPED_QUERY");
    expect(issue).toBeDefined();
    expect(issue?.entity).toBe("Session");
    expect(issue?.className).toBe("SessionService");
    expect(typeof issue?.line).toBe("number");
    expect(issue?.details).toContain("find");
  });
});
