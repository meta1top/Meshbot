import { MeshbotConfigService } from "@meshbot/agent";
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
  } as unknown as jest.Mocked<DriveGatewayService>;
}

function buildMockConfig(): jest.Mocked<MeshbotConfigService> {
  return {
    getWorkspaceDir: jest.fn(() => workspaceDir),
  } as unknown as jest.Mocked<MeshbotConfigService>;
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

// ── share（Task 5 占位） ──────────────────────────────────────
describe("DriveToolService.share", () => {
  it("抛出 not implemented", async () => {
    const gateway = buildMockGateway();
    const svc = await buildService(gateway, buildMockConfig());
    await expect(
      svc.share(
        {
          nodeId: "n1",
          shareWith: "user@example.com",
          permission: "viewer",
          sessionId: "s1",
          toolCallId: "t1",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("not implemented");
  });
});
