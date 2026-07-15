import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { AgentContextService, MeshbotConfigService } from "@meshbot/lib-agent";
import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { AgentService } from "../services/agent.service";

/** 扩展名 → Content-Type（预览/下载用，缺省二进制流）。 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 产物文件实时 serving：按 Agent workspace 解析、防遍历、流式返回。 */
@ApiTags("artifacts")
@Controller("api/artifacts")
export class ArtifactController {
  constructor(
    private readonly config: MeshbotConfigService,
    private readonly agentCtx: AgentContextService,
    private readonly agents: AgentService,
  ) {}

  /**
   * 解析 agentId：未传/空串兜底取当前账号默认 Agent；显式传入必须校验存在且
   * 归属当前账号。收口到 `AgentService.resolveOrDefault()`（与
   * `SessionController.create` / `SkillController` 同一实现，单点维护）。
   */
  private async resolveAgentId(agentId?: string): Promise<string> {
    return (await this.agents.resolveOrDefault(agentId)).id;
  }

  /** 读取 workspace 内产物文件（预览/下载）。 */
  @Get("raw")
  @ApiOperation({ summary: "读取 workspace 内产物文件（预览/下载）" })
  async raw(
    @Query("path") relPath: string,
    @Query("download") download: string | undefined,
    @Query("agentId") agentId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const id = await this.resolveAgentId(agentId);
    return this.agentCtx.run(id, () => {
      const workspaceDir = this.config.getWorkspaceDir();
      const abs = path.resolve(workspaceDir, relPath ?? "");
      if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
        throw new ForbiddenException("path outside workspace");
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        throw new NotFoundException("artifact not found");
      }
      res.setHeader(
        "Content-Type",
        CONTENT_TYPES[path.extname(abs).toLowerCase()] ??
          "application/octet-stream",
      );
      if (download === "1") {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${encodeURIComponent(path.basename(abs))}"`,
        );
      }
      return new StreamableFile(createReadStream(abs));
    });
  }
}
