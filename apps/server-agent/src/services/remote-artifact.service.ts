import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AgentContextService, MeshbotConfigService } from "@meshbot/lib-agent";
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DriveToolService } from "./drive-tool.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** 经查询通道内联回传的上限：产物基本是 markdown/html/代码，2MB 覆盖绝大多数。 */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

/** artifact-file 查询响应：内联内容或「过大」信号（A 侧据此引导网盘路径）。 */
export type RemoteArtifactReadResult =
  | { kind: "content"; name: string; base64: string }
  | { kind: "too-large"; name: string; size: number };

/** artifact-upload-drive 查询响应：已上传网盘的文件引用（A 侧换 presigned URL 预览）。 */
export interface RemoteArtifactUploadResult {
  fileId: string;
  name: string;
}

/**
 * 跨设备产物预览的 B 侧实现：A 设备经设备查询通道请求本机会话产物。
 *
 * 安全不变量：只允许读「该会话消息历史中 present_file 确实呈现过」的
 * 工作区相对路径（白名单校验 + workspace 边界防遍历）——查询通道不得
 * 成为任意文件读取入口。
 */
@Injectable()
export class RemoteArtifactService {
  constructor(
    private readonly config: MeshbotConfigService,
    private readonly messages: SessionMessageService,
    private readonly driveTool: DriveToolService,
    private readonly agentCtx: AgentContextService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * 白名单 + 边界校验，返回绝对路径；任何不满足都抛（inbound 统一转 ok:false）。
   *
   * workspace 路径已下沉到 agents/<agentId>/（Task 4），本方法在该会话归属的
   * Agent 上下文内解析 workspace —— 相比兜底取默认 Agent，这里能拿到真实
   * sessionId 对应的 agentId（Task 2 起 sessions.agent_id 必填），精确寻址。
   */
  private async resolveVerified(
    sessionId: string,
    filePath: string,
  ): Promise<string> {
    if (!(await this.messages.hasPresentedFile(sessionId, filePath))) {
      throw new ForbiddenException("file not presented in this session");
    }
    const session = await this.sessions.findSessionOrFail(sessionId);
    return this.agentCtx.run(session.agentId, () => {
      const dir = this.config.getWorkspaceDir();
      const abs = path.resolve(dir, filePath);
      if (abs !== dir && !abs.startsWith(dir + path.sep)) {
        throw new ForbiddenException("path outside workspace");
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        throw new NotFoundException("artifact not found");
      }
      return abs;
    });
  }

  /** 读产物：≤2MB 内联 base64 回传；超限返回 too-large 信号。 */
  async read(
    sessionId: string,
    filePath: string,
  ): Promise<RemoteArtifactReadResult> {
    const abs = await this.resolveVerified(sessionId, filePath);
    const size = statSync(abs).size;
    const name = path.basename(abs);
    if (size > MAX_INLINE_BYTES) {
      return { kind: "too-large", name, size };
    }
    return {
      kind: "content",
      name,
      base64: readFileSync(abs).toString("base64"),
    };
  }

  /**
   * 大文件路径：上传企业网盘（组织共享，A 侧可直接取 presigned URL 预览）。
   * `driveTool.upload` 内部也会读 `getWorkspaceDir()`，同样需要该会话的 Agent
   * 上下文——外层 `resolveVerified` 已校验通过，这里重新以同一 agentId 包一层。
   */
  async uploadToDrive(
    sessionId: string,
    filePath: string,
  ): Promise<RemoteArtifactUploadResult> {
    const abs = await this.resolveVerified(sessionId, filePath);
    const session = await this.sessions.findSessionOrFail(sessionId);
    const out = await this.agentCtx.run(session.agentId, () =>
      this.driveTool.upload(filePath, null, undefined),
    );
    if (out.startsWith("Error:")) {
      throw new NotFoundException(out);
    }
    const parsed = JSON.parse(out) as {
      node?: { id?: unknown; name?: unknown };
    };
    if (typeof parsed.node?.id !== "string") {
      throw new NotFoundException("drive upload returned no node id");
    }
    return {
      fileId: parsed.node.id,
      name:
        typeof parsed.node.name === "string"
          ? parsed.node.name
          : path.basename(abs),
    };
  }
}
