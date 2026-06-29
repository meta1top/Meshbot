import { AccountContextService, MeshbotConfigService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { Test, TestingModule } from "@nestjs/testing";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudIdentityService } from "./cloud-identity.service";
import { CloudOrgService } from "./cloud-org.service";
import { ConfirmationService } from "./confirmation.service";
import { DriveGatewayService } from "./drive-gateway.service";
import { DriveToolService } from "./drive-tool.service";

// ── 全局 fetch mock 管理 ─────────────────────────────────────
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

// ── 测试用临时 workspace ──────────────────────────────────────
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = path.join(os.tmpdir(), `drive-tool-test-${Date.now()}`);
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ── mock 工厂 ─────────────────────────────────────────────────
function buildMockGateway(): jest.Mocked<DriveGatewayService> {
  return {
    listNodes: jest.fn(),
    createFolder: jest.fn(),
    requestUpload: jest.fn(),
    completeUpload: jest.fn(),
    getFileUrl: jest.fn(),
    getGrants: jest.fn(),
    setGrants: jest.fn(),
  } as unknown as jest.Mocked<DriveGatewayService>;
}

function buildMockConfig(): jest.Mocked<MeshbotConfigService> {
  return {
    getWorkspaceDir: jest.fn(() => workspaceDir),
  } as unknown as jest.Mocked<MeshbotConfigService>;
}

function buildMockConfirmation(): jest.Mocked<ConfirmationService> {
  return {
    waitForDecision: jest.fn(),
  } as unknown as jest.Mocked<ConfirmationService>;
}

function buildMockAccount(
  userId = "user-123",
): jest.Mocked<AccountContextService> {
  return {
    getOrThrow: jest.fn(() => userId),
    get: jest.fn(() => userId),
  } as unknown as jest.Mocked<AccountContextService>;
}

function buildMockIdentity(
  orgId: string | null = "org-001",
): jest.Mocked<CloudIdentityService> {
  return {
    get: jest.fn().mockResolvedValue({ orgId, cloudToken: "tok" }),
  } as unknown as jest.Mocked<CloudIdentityService>;
}

function buildMockCloudOrg(
  members: Array<{ userId: string; email: string }> = [],
): jest.Mocked<CloudOrgService> {
  return {
    listMembers: jest.fn().mockResolvedValue(members),
  } as unknown as jest.Mocked<CloudOrgService>;
}

async function buildService(
  gateway: DriveGatewayService,
  config: MeshbotConfigService,
): Promise<DriveToolService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      DriveToolService,
      { provide: DriveGatewayService, useValue: gateway },
      { provide: MeshbotConfigService, useValue: config },
      { provide: ConfirmationService, useValue: buildMockConfirmation() },
      { provide: AccountContextService, useValue: buildMockAccount() },
      { provide: CloudIdentityService, useValue: buildMockIdentity() },
      { provide: CloudOrgService, useValue: buildMockCloudOrg() },
    ],
  }).compile();
  return module.get(DriveToolService);
}

/** share 专用构建函数，可自定义各依赖 mock。 */
async function buildShareService(
  opts: {
    confirmation?: jest.Mocked<ConfirmationService>;
    account?: jest.Mocked<AccountContextService>;
    identity?: jest.Mocked<CloudIdentityService>;
    cloudOrg?: jest.Mocked<CloudOrgService>;
    gateway?: jest.Mocked<DriveGatewayService>;
  } = {},
): Promise<DriveToolService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      DriveToolService,
      {
        provide: DriveGatewayService,
        useValue: opts.gateway ?? buildMockGateway(),
      },
      { provide: MeshbotConfigService, useValue: buildMockConfig() },
      {
        provide: ConfirmationService,
        useValue: opts.confirmation ?? buildMockConfirmation(),
      },
      {
        provide: AccountContextService,
        useValue: opts.account ?? buildMockAccount(),
      },
      {
        provide: CloudIdentityService,
        useValue: opts.identity ?? buildMockIdentity(),
      },
      {
        provide: CloudOrgService,
        useValue: opts.cloudOrg ?? buildMockCloudOrg(),
      },
    ],
  }).compile();
  return module.get(DriveToolService);
}

// ── list ──────────────────────────────────────────────────────
describe("DriveToolService.list", () => {
  it("调用 gateway.listNodes(parentId) 并返回 JSON", async () => {
    const gateway = buildMockGateway();
    const config = buildMockConfig();
    const nodes = [{ id: "n1", name: "folder" }];
    gateway.listNodes.mockResolvedValue(nodes);
    const svc = await buildService(gateway, config);

    const result = await svc.list("parent-123");
    expect(gateway.listNodes).toHaveBeenCalledWith("parent-123");
    expect(JSON.parse(result)).toEqual(nodes);
  });

  it("parentId=null 时透传 null", async () => {
    const gateway = buildMockGateway();
    gateway.listNodes.mockResolvedValue([]);
    const svc = await buildService(gateway, buildMockConfig());

    await svc.list(null);
    expect(gateway.listNodes).toHaveBeenCalledWith(null);
  });
});

// ── mkdir ─────────────────────────────────────────────────────
describe("DriveToolService.mkdir", () => {
  it("调用 gateway.createFolder({name, parentId}) 并返回 JSON", async () => {
    const gateway = buildMockGateway();
    const folder = { id: "f1", name: "reports" };
    gateway.createFolder.mockResolvedValue(folder);
    const svc = await buildService(gateway, buildMockConfig());

    const result = await svc.mkdir("parent-456", "reports");
    expect(gateway.createFolder).toHaveBeenCalledWith({
      name: "reports",
      parentId: "parent-456",
    });
    expect(JSON.parse(result)).toEqual(folder);
  });
});

// ── upload ────────────────────────────────────────────────────
describe("DriveToolService.upload", () => {
  it("成功：读文件 → requestUpload → PUT putUrl → completeUpload → 返回 JSON", async () => {
    const gateway = buildMockGateway();
    const config = buildMockConfig();
    // 写一个工作区文件
    const filePath = path.join(workspaceDir, "report.pdf");
    writeFileSync(filePath, Buffer.from("PDF content"));
    gateway.requestUpload.mockResolvedValue({
      nodeId: "node-99",
      putUrl: "https://s3.example.com/put",
    });
    gateway.completeUpload.mockResolvedValue({
      id: "node-99",
      status: "ready",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as never;

    const svc = await buildService(gateway, config);
    const result = await svc.upload("report.pdf", null, undefined);

    expect(gateway.requestUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "report.pdf", parentId: null }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://s3.example.com/put",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(gateway.completeUpload).toHaveBeenCalledWith("node-99", {});
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("uploaded");
  });

  it("upload：越界路径 → 返回 Error 字符串，不调用 gateway", async () => {
    const gateway = buildMockGateway();
    const svc = await buildService(gateway, buildMockConfig());

    const result = await svc.upload("../etc/passwd", null, undefined);
    expect(result).toMatch(/outside.*workspace/);
    expect(gateway.requestUpload).not.toHaveBeenCalled();
  });

  it("upload：绝对路径越界 → 拒绝", async () => {
    const gateway = buildMockGateway();
    const svc = await buildService(gateway, buildMockConfig());

    const result = await svc.upload("/etc/passwd", null, undefined);
    expect(result).toMatch(/outside.*workspace/);
    expect(gateway.requestUpload).not.toHaveBeenCalled();
  });

  it("upload：文件不存在 → Error 字符串", async () => {
    const gateway = buildMockGateway();
    const svc = await buildService(gateway, buildMockConfig());

    const result = await svc.upload("nonexistent.txt", null, undefined);
    expect(result).toMatch(/does not exist/);
  });

  it("upload：PUT 返回非 2xx → 抛出 AppError(DRIVE_UPLOAD_FAILED)", async () => {
    const gateway = buildMockGateway();
    const config = buildMockConfig();
    writeFileSync(path.join(workspaceDir, "file.txt"), "data");
    gateway.requestUpload.mockResolvedValue({
      nodeId: "node-1",
      putUrl: "https://s3.example.com/put",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 403 }) as never;

    const svc = await buildService(gateway, config);
    await expect(
      svc.upload("file.txt", null, undefined),
    ).rejects.toBeInstanceOf(AppError);
    expect(gateway.completeUpload).not.toHaveBeenCalled();
  });

  it("upload：name 参数覆盖文件名", async () => {
    const gateway = buildMockGateway();
    const config = buildMockConfig();
    writeFileSync(path.join(workspaceDir, "report.pdf"), "PDF");
    gateway.requestUpload.mockResolvedValue({
      nodeId: "n",
      putUrl: "https://s3.example.com/put",
    });
    gateway.completeUpload.mockResolvedValue({ id: "n" });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as never;

    const svc = await buildService(gateway, config);
    await svc.upload("report.pdf", null, "custom-name.pdf");

    expect(gateway.requestUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "custom-name.pdf" }),
    );
  });
});

// ── download ──────────────────────────────────────────────────
describe("DriveToolService.download", () => {
  it("成功：getFileUrl → GET url → 写文件 → 返回 JSON 含相对路径", async () => {
    const gateway = buildMockGateway();
    const config = buildMockConfig();
    gateway.getFileUrl.mockResolvedValue({
      url: "https://cdn.example.com/file",
    });
    const fileContent = "hello world";
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(fileContent).buffer,
    }) as never;

    const svc = await buildService(gateway, config);
    const result = await svc.download("file-id-123", "downloads/hello.txt");

    expect(gateway.getFileUrl).toHaveBeenCalledWith("file-id-123");
    expect(global.fetch).toHaveBeenCalledWith("https://cdn.example.com/file");
    const destAbs = path.join(workspaceDir, "downloads", "hello.txt");
    expect(existsSync(destAbs)).toBe(true);
    expect(readFileSync(destAbs, "utf8")).toBe(fileContent);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("downloaded");
    expect(parsed.path).toBe(path.join("downloads", "hello.txt"));
  });

  it("download：越界 destPath → 拒绝", async () => {
    const gateway = buildMockGateway();
    const svc = await buildService(gateway, buildMockConfig());

    const result = await svc.download("file-id", "../evil.txt");
    expect(result).toMatch(/outside.*workspace/);
    expect(gateway.getFileUrl).not.toHaveBeenCalled();
  });

  it("download：绝对路径越界 → 拒绝", async () => {
    const gateway = buildMockGateway();
    const svc = await buildService(gateway, buildMockConfig());

    const result = await svc.download("file-id", "/tmp/evil.txt");
    expect(result).toMatch(/outside.*workspace/);
  });

  it("download：GET 非 2xx → 抛出 AppError(DRIVE_DOWNLOAD_FAILED)", async () => {
    const gateway = buildMockGateway();
    gateway.getFileUrl.mockResolvedValue({
      url: "https://cdn.example.com/file",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404 }) as never;

    const svc = await buildService(gateway, buildMockConfig());
    await expect(
      svc.download("file-id", "downloads/file.txt"),
    ).rejects.toBeInstanceOf(AppError);
  });
});

// ── share（Task 5） ───────────────────────────────────────────
describe("DriveToolService.share", () => {
  const shareArgs = {
    nodeId: "node-abc",
    shareWith: "org",
    permission: "viewer" as const,
    sessionId: "sess-1",
    toolCallId: "tc-1",
  };

  // ── shareWith="org" 确认通过 → setGrants 含 org grant ────────
  it('shareWith="org" 确认通过 → setGrants 含 org grant（granteeId=当前 orgId）', async () => {
    const confirmation = buildMockConfirmation();
    const account = buildMockAccount("user-123");
    const identity = buildMockIdentity("org-001");
    const gateway = buildMockGateway();

    // 确认通过（任意 payload 视为通过）
    confirmation.waitForDecision.mockResolvedValue({ action: "send" });
    // 现有 grants 为空
    gateway.getGrants.mockResolvedValue({ grants: [] });
    gateway.setGrants.mockResolvedValue({});

    const svc = await buildShareService({
      confirmation,
      account,
      identity,
      gateway,
    });
    const result = JSON.parse(
      await svc.share(
        { ...shareArgs, shareWith: "org" },
        new AbortController().signal,
      ),
    );

    expect(result.status).toBe("shared");
    expect(result.shareWith).toBe("org");
    expect(gateway.setGrants).toHaveBeenCalledWith(
      "node-abc",
      expect.objectContaining({
        grants: expect.arrayContaining([
          expect.objectContaining({
            granteeType: "org",
            granteeId: "org-001",
            permission: "viewer",
          }),
        ]),
      }),
    );
  });

  // ── shareWith=email 命中成员 → setGrants 含 user grant ───────
  it("shareWith=email 命中成员 → setGrants 含 user grant（granteeId=userId）", async () => {
    const confirmation = buildMockConfirmation();
    const identity = buildMockIdentity("org-001");
    const cloudOrg = buildMockCloudOrg([
      { userId: "u-42", email: "alice@example.com" },
    ]);
    const gateway = buildMockGateway();

    confirmation.waitForDecision.mockResolvedValue({ action: "send" });
    gateway.getGrants.mockResolvedValue({ grants: [] });
    gateway.setGrants.mockResolvedValue({});

    const svc = await buildShareService({
      confirmation,
      identity,
      cloudOrg,
      gateway,
    });
    const result = JSON.parse(
      await svc.share(
        { ...shareArgs, shareWith: "alice@example.com", permission: "editor" },
        new AbortController().signal,
      ),
    );

    expect(result.status).toBe("shared");
    expect(gateway.setGrants).toHaveBeenCalledWith(
      "node-abc",
      expect.objectContaining({
        grants: expect.arrayContaining([
          expect.objectContaining({
            granteeType: "user",
            granteeId: "u-42",
            permission: "editor",
          }),
        ]),
      }),
    );
  });

  // ── email 大小写不敏感 → 匹配成功 ───────────────────────────
  it("email 大小写不同也能匹配（库里 bob@x.com，传入 Bob@X.com）", async () => {
    const confirmation = buildMockConfirmation();
    const identity = buildMockIdentity("org-001");
    const cloudOrg = buildMockCloudOrg([
      { userId: "u-99", email: "bob@x.com" },
    ]);
    const gateway = buildMockGateway();

    confirmation.waitForDecision.mockResolvedValue({ action: "send" });
    gateway.getGrants.mockResolvedValue({ grants: [] });
    gateway.setGrants.mockResolvedValue({});

    const svc = await buildShareService({
      confirmation,
      identity,
      cloudOrg,
      gateway,
    });
    const result = JSON.parse(
      await svc.share(
        { ...shareArgs, shareWith: "Bob@X.com", permission: "viewer" },
        new AbortController().signal,
      ),
    );

    expect(result.status).toBe("shared");
    expect(gateway.setGrants).toHaveBeenCalledWith(
      "node-abc",
      expect.objectContaining({
        grants: expect.arrayContaining([
          expect.objectContaining({
            granteeType: "user",
            granteeId: "u-99",
            permission: "viewer",
          }),
        ]),
      }),
    );
  });

  // ── email 不命中 → 返回 Error 字符串，不挂起 ─────────────────
  it("email 不命中成员 → 返回 Error 字符串，不调 waitForDecision", async () => {
    const confirmation = buildMockConfirmation();
    const cloudOrg = buildMockCloudOrg([]); // 无成员
    const gateway = buildMockGateway();

    const svc = await buildShareService({ confirmation, cloudOrg, gateway });
    const result = await svc.share(
      { ...shareArgs, shareWith: "nobody@example.com" },
      new AbortController().signal,
    );

    expect(result).toMatch(/cannot resolve share target/);
    expect(confirmation.waitForDecision).not.toHaveBeenCalled();
    expect(gateway.setGrants).not.toHaveBeenCalled();
  });

  // ── 确认 "aborted" → interrupted，不调 setGrants ────────────
  it('确认 "aborted" → {status:"interrupted"}，不调 setGrants', async () => {
    const confirmation = buildMockConfirmation();
    const gateway = buildMockGateway();

    confirmation.waitForDecision.mockResolvedValue("aborted");

    const svc = await buildShareService({ confirmation, gateway });
    const result = JSON.parse(
      await svc.share(
        { ...shareArgs, shareWith: "org" },
        new AbortController().signal,
      ),
    );

    expect(result.status).toBe("interrupted");
    expect(gateway.setGrants).not.toHaveBeenCalled();
  });

  // ── 用户点取消 {action:"cancel"} → cancelled，不调 setGrants ──
  it('{action:"cancel"} → {status:"cancelled"}，setGrants 未被调用', async () => {
    const confirmation = buildMockConfirmation();
    const gateway = buildMockGateway();

    confirmation.waitForDecision.mockResolvedValue({ action: "cancel" });

    const svc = await buildShareService({ confirmation, gateway });
    const result = JSON.parse(
      await svc.share(
        { ...shareArgs, shareWith: "org" },
        new AbortController().signal,
      ),
    );

    expect(result.status).toBe("cancelled");
    expect(gateway.setGrants).not.toHaveBeenCalled();
  });

  // ── 确认 "timeout" → timeout，不调 setGrants ─────────────────
  it('确认 "timeout" → {status:"timeout"}，不调 setGrants', async () => {
    const confirmation = buildMockConfirmation();
    const gateway = buildMockGateway();

    confirmation.waitForDecision.mockResolvedValue("timeout");

    const svc = await buildShareService({ confirmation, gateway });
    const result = JSON.parse(
      await svc.share(
        { ...shareArgs, shareWith: "org" },
        new AbortController().signal,
      ),
    );

    expect(result.status).toBe("timeout");
    expect(gateway.setGrants).not.toHaveBeenCalled();
  });

  // ── mergeGrant：同 grantee 覆盖 permission ───────────────────
  it("mergeGrant：同 (granteeType, granteeId) 覆盖 permission", async () => {
    const confirmation = buildMockConfirmation();
    const identity = buildMockIdentity("org-001");
    const gateway = buildMockGateway();

    confirmation.waitForDecision.mockResolvedValue({ action: "send" });
    // 现有 grant：org-001 已有 viewer
    gateway.getGrants.mockResolvedValue({
      grants: [
        { granteeType: "org", granteeId: "org-001", permission: "viewer" },
      ],
    });
    gateway.setGrants.mockResolvedValue({});

    const svc = await buildShareService({ confirmation, identity, gateway });
    await svc.share(
      { ...shareArgs, shareWith: "org", permission: "editor" },
      new AbortController().signal,
    );

    const [, body] = gateway.setGrants.mock.calls[0] as [
      string,
      { grants: unknown[] },
    ];
    const grants = body.grants;
    // 应只有一条，permission 被覆盖为 editor
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      granteeType: "org",
      granteeId: "org-001",
      permission: "editor",
    });
  });

  // ── mergeGrant：不同 grantee 追加 ────────────────────────────
  it("mergeGrant：不同 grantee 追加（保留原有）", async () => {
    const confirmation = buildMockConfirmation();
    const identity = buildMockIdentity("org-001");
    const cloudOrg = buildMockCloudOrg([
      { userId: "u-99", email: "bob@example.com" },
    ]);
    const gateway = buildMockGateway();

    confirmation.waitForDecision.mockResolvedValue({ action: "send" });
    // 现有 grant：org-001 viewer
    gateway.getGrants.mockResolvedValue({
      grants: [
        { granteeType: "org", granteeId: "org-001", permission: "viewer" },
      ],
    });
    gateway.setGrants.mockResolvedValue({});

    const svc = await buildShareService({
      confirmation,
      identity,
      cloudOrg,
      gateway,
    });
    await svc.share(
      { ...shareArgs, shareWith: "bob@example.com", permission: "editor" },
      new AbortController().signal,
    );

    const [, body] = gateway.setGrants.mock.calls[0] as [
      string,
      { grants: unknown[] },
    ];
    const grants = body.grants;
    // 原有 org grant + 新 user grant，共 2 条
    expect(grants).toHaveLength(2);
    expect(grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          granteeType: "org",
          granteeId: "org-001",
          permission: "viewer",
        }),
        expect.objectContaining({
          granteeType: "user",
          granteeId: "u-99",
          permission: "editor",
        }),
      ]),
    );
  });
});
