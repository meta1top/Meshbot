import { DataSource } from "typeorm";
import { CloudIdentity } from "../entities/cloud-identity.entity";
import { CloudIdentityService } from "./cloud-identity.service";

/** 构造一行 upsert 字段（默认值，按需覆盖）。 */
function fields(
  cloudUserId: string,
  over: Partial<Parameters<CloudIdentityService["upsert"]>[0]> = {},
) {
  return {
    cloudUserId,
    email: `${cloudUserId}@x.io`,
    displayName: cloudUserId,
    cloudToken: `tok-${cloudUserId}`,
    cloudTokenExpiresAt: null,
    orgId: null,
    orgName: null,
    role: null,
    ...over,
  };
}

describe("CloudIdentityService（多行）", () => {
  let ds: DataSource;
  let service: CloudIdentityService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [CloudIdentity],
      synchronize: true,
    });
    await ds.initialize();
    service = new CloudIdentityService(ds.getRepository(CloudIdentity));
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("upsert → get(id) 返回该行且 loggedIn=true", async () => {
    await service.upsert(
      fields("u1", { orgId: "o1", orgName: "Acme", role: "owner" }),
    );
    const row = await service.get("u1");
    expect(row).not.toBeNull();
    expect(row?.cloudUserId).toBe("u1");
    expect(row?.email).toBe("u1@x.io");
    expect(row?.orgId).toBe("o1");
    expect(row?.cloudToken).toBe("tok-u1");
    expect(row?.loggedIn).toBe(true);
  });

  it("get 不存在的账号返回 null", async () => {
    expect(await service.get("nope")).toBeNull();
  });

  it("两账号互不覆盖（独立行）", async () => {
    await service.upsert(fields("u1"));
    await service.upsert(fields("u2"));

    const u1 = await service.get("u1");
    const u2 = await service.get("u2");
    expect(u1?.cloudUserId).toBe("u1");
    expect(u1?.cloudToken).toBe("tok-u1");
    expect(u2?.cloudUserId).toBe("u2");
    expect(u2?.cloudToken).toBe("tok-u2");
  });

  it("updateActiveOrg 只更新指定账号的组织", async () => {
    await service.upsert(fields("u1"));
    await service.upsert(fields("u2"));

    await service.updateActiveOrg("u1", "o9", "Org9", "member");

    expect(await service.get("u1")).toMatchObject({
      orgId: "o9",
      orgName: "Org9",
      role: "member",
    });
    expect(await service.get("u2")).toMatchObject({
      orgId: null,
      orgName: null,
      role: null,
    });
  });

  it("setLoggedOut 只翻转该账号 loggedIn（保留行与 token）", async () => {
    await service.upsert(fields("u1"));
    await service.upsert(fields("u2"));

    await service.setLoggedOut("u1");

    const u1 = await service.get("u1");
    expect(u1).not.toBeNull();
    expect(u1?.loggedIn).toBe(false);
    expect(u1?.cloudToken).toBe("tok-u1");

    const u2 = await service.get("u2");
    expect(u2?.loggedIn).toBe(true);
  });

  it("listLoggedIn 只返回 loggedIn=true 的账号", async () => {
    await service.upsert(fields("u1"));
    await service.upsert(fields("u2"));
    await service.upsert(fields("u3"));
    await service.setLoggedOut("u2");

    const loggedIn = await service.listLoggedIn();
    const ids = loggedIn.map((r) => r.cloudUserId).sort();
    expect(ids).toEqual(["u1", "u3"]);
  });
});
