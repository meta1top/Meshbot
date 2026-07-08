import { CommonErrorCode } from "@meshbot/common";
import { SecretCryptoService } from "./secret-crypto.service";
import { OrgModelConfigService } from "./org-model-config.service";
import type { OrgModelConfig } from "../entities/org-model-config.entity";

const crypto = new SecretCryptoService({
  encryptionKey: "0123456789abcdef0123456789abcdef",
});

function makeRepo(rows: OrgModelConfig[]) {
  return {
    create: jest.fn(
      (v: Partial<OrgModelConfig>) =>
        ({
          enabled: true,
          baseUrl: "",
          contextWindow: 128000,
          ...v,
        }) as OrgModelConfig,
    ),
    save: jest.fn(async (v: OrgModelConfig) => {
      v.id ??= `m${rows.length + 1}`;
      if (!rows.includes(v)) rows.push(v);
      return v;
    }),
    find: jest.fn(async ({ where }: never) =>
      rows.filter((r) => r.orgId === (where as { orgId: string }).orgId),
    ),
    findOne: jest.fn(async ({ where }: never) => {
      const w = where as { id: string; orgId: string };
      return rows.find((r) => r.id === w.id && r.orgId === w.orgId) ?? null;
    }),
    delete: jest.fn(async (cond: { id: string }) => {
      const i = rows.findIndex((r) => r.id === cond.id);
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}

describe("OrgModelConfigService", () => {
  const input = {
    name: "默认",
    providerType: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "sk-abcd1234",
    baseUrl: "",
    contextWindow: 200000,
    enabled: true,
  };

  it("create 加密入库,listForAdmin 打码,listForAgent 解密", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    await svc.create("o1", input);
    expect(rows[0].apiKeyEnc).not.toContain("sk-abcd1234");
    const admin = await svc.listForAdmin("o1");
    expect(admin[0].apiKeyMasked).toBe("****1234");
    const agent = await svc.listForAgent("o1");
    expect(agent[0].apiKey).toBe("sk-abcd1234");
  });

  it("create 缺 apiKey 抛 VALIDATION_FAILED", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    await expect(
      svc.create("o1", { ...input, apiKey: undefined }),
    ).rejects.toMatchObject({
      name: "AppError",
      errorCode: CommonErrorCode.VALIDATION_FAILED,
    });
    expect(rows).toHaveLength(0);
  });

  it("update 不传 apiKey 时保留旧密钥", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    const created = await svc.create("o1", input);
    await svc.update("o1", created.id, { name: "改名" });
    const agent = await svc.listForAgent("o1");
    expect(agent[0].apiKey).toBe("sk-abcd1234");
    expect(agent[0].name).toBe("改名");
  });

  it("listForAgent 过滤 enabled=false", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    const created = await svc.create("o1", input);
    await svc.update("o1", created.id, { enabled: false });
    expect(await svc.listForAgent("o1")).toHaveLength(0);
  });

  it("跨组织 update/remove 抛 DEVICE_NOT_FOUND 级别的未找到错误", async () => {
    const rows: OrgModelConfig[] = [];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    const created = await svc.create("o1", input);
    await expect(
      svc.update("o2", created.id, { name: "x" }),
    ).rejects.toMatchObject({ name: "AppError" });
    await expect(svc.remove("o2", created.id)).rejects.toMatchObject({
      name: "AppError",
    });
  });
});

describe("resolveDecrypted", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeRow(overrides: Partial<OrgModelConfig> = {}): OrgModelConfig {
    return {
      id: "m1",
      orgId: "o1",
      name: "默认",
      providerType: "openai",
      model: "gpt-4o",
      apiKeyEnc: "ENC",
      baseUrl: null,
      contextWindow: 128000,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as OrgModelConfig;
  }

  it("按 id+orgId 命中并解密", async () => {
    const rows: OrgModelConfig[] = [makeRow()];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    jest.spyOn(crypto, "decrypt").mockReturnValue("sk-real");
    const r = await svc.resolveDecrypted("o1", "m1");
    expect(r).toEqual({
      providerType: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk-real",
      contextWindow: 128000,
    });
  });

  it("跨 org 不命中 → null", async () => {
    const rows: OrgModelConfig[] = [makeRow()];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    const r = await svc.resolveDecrypted("other-org", "m1");
    expect(r).toBeNull();
  });

  it("id 不存在 → null", async () => {
    const rows: OrgModelConfig[] = [makeRow()];
    const svc = new OrgModelConfigService(makeRepo(rows) as never, crypto);
    const r = await svc.resolveDecrypted("o1", "missing");
    expect(r).toBeNull();
  });
});
