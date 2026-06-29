import { MeshbotConfigService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { DrivePort } from "@meshbot/agent";

import { AgentErrorCode } from "../errors/agent.error-codes";
import { DriveGatewayService } from "./drive-gateway.service";

/**
 * 解析文件路径：绝对路径直接 normalize；相对路径对 workspaceDir 解析。
 * 逻辑与 libs/agent/src/tools/builtins/file-path.util.ts 保持一致。
 */
function resolveFilePath(filePath: string, workspaceDir: string): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workspaceDir, filePath);
}

/**
 * 根据文件扩展名返回 MIME 类型；无匹配时兜底 application/octet-stream。
 */
function lookupMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".csv": "text/csv",
    ".xml": "application/xml",
    ".wasm": "application/wasm",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * DrivePort 实现：协调 DriveGatewayService 与本地 workspace 文件系统，
 * 提供 list / mkdir / upload / download 四个直接操作。
 * share 方法留 Task 5 实现（HITL 确认流程）。
 */
@Injectable()
export class DriveToolService implements DrivePort {
  constructor(
    private readonly gateway: DriveGatewayService,
    private readonly config: MeshbotConfigService,
  ) {}

  /** 列出网盘目录（parentId=null 为根）；返回 JSON 字符串。 */
  async list(parentId: string | null): Promise<string> {
    return JSON.stringify(await this.gateway.listNodes(parentId));
  }

  /** 在网盘指定目录下创建文件夹；返回 JSON 字符串。 */
  async mkdir(parentId: string | null, name: string): Promise<string> {
    return JSON.stringify(await this.gateway.createFolder({ name, parentId }));
  }

  /**
   * 将 workspace 文件上传至网盘。
   * path 为相对或绝对路径，必须在 workspace 目录内。
   * 上传流程：读文件 → requestUpload 拿 putUrl → PUT 文件 → completeUpload。
   */
  async upload(
    p: string,
    parentId: string | null,
    name: string | undefined,
  ): Promise<string> {
    const dir = this.config.getWorkspaceDir();
    const abs = resolveFilePath(p, dir);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      return `Error: path is outside the workspace: ${p}`;
    }
    if (!existsSync(abs)) {
      return `Error: file does not exist: ${p}`;
    }
    const buf = readFileSync(abs);
    const fileName = name ?? path.basename(abs);
    const mime = lookupMime(abs);
    const req = (await this.gateway.requestUpload({
      name: fileName,
      parentId,
      size: buf.length,
      mime,
    })) as { nodeId: string; putUrl: string };
    const put = await fetch(req.putUrl, { method: "PUT", body: buf });
    if (!put.ok) {
      throw new AppError(AgentErrorCode.DRIVE_UPLOAD_FAILED);
    }
    const node = await this.gateway.completeUpload(req.nodeId, {});
    return JSON.stringify({ status: "uploaded", node });
  }

  /**
   * 从网盘下载文件到 workspace 指定路径。
   * destPath 为相对或绝对路径，必须在 workspace 目录内。
   * 下载流程：getFileUrl → GET url → 写入本地文件。
   */
  async download(fileId: string, destPath: string): Promise<string> {
    const dir = this.config.getWorkspaceDir();
    const abs = resolveFilePath(destPath, dir);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      return `Error: path is outside the workspace: ${destPath}`;
    }
    const { url } = (await this.gateway.getFileUrl(fileId)) as { url: string };
    const res = await fetch(url);
    if (!res.ok) {
      throw new AppError(AgentErrorCode.DRIVE_DOWNLOAD_FAILED);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    return JSON.stringify({
      status: "downloaded",
      path: path.relative(dir, abs),
    });
  }

  /**
   * 共享节点给指定用户（HITL 确认流程）。
   * Task 5 实现。
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async share(
    _args: {
      nodeId: string;
      shareWith: string;
      permission: "viewer" | "editor";
      sessionId: string;
      toolCallId: string;
    },
    _signal: AbortSignal,
  ): Promise<string> {
    throw new Error("not implemented (Task 5)");
  }
}
