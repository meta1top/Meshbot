import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentContextService, MeshbotConfigService } from "@meshbot/lib-agent";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import type { Session } from "../entities/session.entity";
import { DriveToolService } from "./drive-tool.service";
import { RemoteArtifactService } from "./remote-artifact.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

const SESSION_ID = "sess-1";
const AGENT_ID = "agent-remote-1";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = path.join(os.tmpdir(), `remote-artifact-test-${Date.now()}`);
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function buildMockMessages(
  presented = true,
): jest.Mocked<Pick<SessionMessageService, "hasPresentedFile">> {
  return {
    hasPresentedFile: jest.fn().mockResolvedValue(presented),
  };
}

function buildMockSessions(
  agentId = AGENT_ID,
): jest.Mocked<Pick<SessionService, "findSessionOrFail">> {
  return {
    findSessionOrFail: jest
      .fn()
      .mockResolvedValue({ id: SESSION_ID, agentId } as Session),
  };
}

function buildMockDriveTool(): jest.Mocked<Pick<DriveToolService, "upload">> {
  return { upload: jest.fn() };
}

/** 真实 AgentContextService + 真实 MeshbotConfigService（只 mock account 依赖）。 */
async function buildService(opts: {
  messages?: jest.Mocked<Pick<SessionMessageService, "hasPresentedFile">>;
  sessions?: jest.Mocked<Pick<SessionService, "findSessionOrFail">>;
  driveTool?: jest.Mocked<Pick<DriveToolService, "upload">>;
}): Promise<{
  service: RemoteArtifactService;
  agentCtx: AgentContextService;
}> {
  const agentCtx = new AgentContextService();
  const config = {
    getWorkspaceDir: jest.fn(() => {
      // 只有在 agentCtx 内才应该被调用；否则 getOrThrow 会先抛错，
      // 这里直接模拟真实 sink 行为：无 agent 上下文时抛错。
      agentCtx.getOrThrow();
      return workspaceDir;
    }),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RemoteArtifactService,
      { provide: MeshbotConfigService, useValue: config },
      {
        provide: SessionMessageService,
        useValue: opts.messages ?? buildMockMessages(),
      },
      {
        provide: DriveToolService,
        useValue: opts.driveTool ?? buildMockDriveTool(),
      },
      { provide: AgentContextService, useValue: agentCtx },
      {
        provide: SessionService,
        useValue: opts.sessions ?? buildMockSessions(),
      },
    ],
  }).compile();
  return { service: module.get(RemoteArtifactService), agentCtx };
}

describe("RemoteArtifactService.read", () => {
  it("在会话归属 Agent 的上下文内解析 workspace，≤2MB 内联 base64 回传", async () => {
    writeFileSync(path.join(workspaceDir, "report.md"), "hello");
    const { service } = await buildService({});

    const result = await service.read(SESSION_ID, "report.md");
    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(Buffer.from(result.base64, "base64").toString()).toBe("hello");
    }
  });

  it("未在该会话 present 过的文件 → ForbiddenException", async () => {
    const { service } = await buildService({
      messages: buildMockMessages(false),
    });

    await expect(service.read(SESSION_ID, "secret.md")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("文件不存在 → NotFoundException", async () => {
    const { service } = await buildService({});

    await expect(service.read(SESSION_ID, "missing.md")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("路径越界 workspace → ForbiddenException", async () => {
    const { service } = await buildService({});

    await expect(service.read(SESSION_ID, "../evil.md")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("确实在 session.agentId 对应的 Agent 上下文内调用了 getWorkspaceDir（脱离上下文会抛错，能跑通即证明已被正确包裹）", async () => {
    writeFileSync(path.join(workspaceDir, "a.txt"), "x");
    const sessions = buildMockSessions("agent-xyz");
    const { service } = await buildService({ sessions });

    await service.read(SESSION_ID, "a.txt");
    expect(sessions.findSessionOrFail).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe("RemoteArtifactService.uploadToDrive", () => {
  it("在会话归属 Agent 的上下文内校验 + 上传，返回 fileId/name", async () => {
    writeFileSync(path.join(workspaceDir, "big.zip"), "zip-bytes");
    const driveTool = buildMockDriveTool();
    driveTool.upload.mockResolvedValue(
      JSON.stringify({
        status: "uploaded",
        node: { id: "n1", name: "big.zip" },
      }),
    );
    const { service } = await buildService({ driveTool });

    const result = await service.uploadToDrive(SESSION_ID, "big.zip");
    expect(result).toEqual({ fileId: "n1", name: "big.zip" });
    expect(driveTool.upload).toHaveBeenCalledWith("big.zip", null, undefined);
  });

  it("drive upload 返回 Error 字符串 → NotFoundException", async () => {
    writeFileSync(path.join(workspaceDir, "big.zip"), "zip-bytes");
    const driveTool = buildMockDriveTool();
    driveTool.upload.mockResolvedValue("Error: boom");
    const { service } = await buildService({ driveTool });

    await expect(
      service.uploadToDrive(SESSION_ID, "big.zip"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
