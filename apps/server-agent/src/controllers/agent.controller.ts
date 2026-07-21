import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AccountContextService,
  AgentContextService,
  McpConfigSchema,
  McpService,
  MeshbotConfigService,
} from "@meshbot/lib-agent";
import type { AgentView } from "@meshbot/types-agent";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  AgentCreateDto,
  AgentUpdateDto,
  AgentViewDto,
  McpRawDto,
} from "../dto/agent.dto";
import type { Agent } from "../entities/agent.entity";
import { AgentService } from "../services/agent.service";

/** Entity → 对外视图。日期转 ISO 字符串，与 AgentViewSchema 对齐。 */
function toAgentView(agent: Agent): AgentView {
  return {
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    defaultModelConfigId: agent.defaultModelConfigId,
    remoteEnabled: agent.remoteEnabled,
    visibility: agent.visibility,
    sortOrder: agent.sortOrder,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

/**
 * Agent CRUD + mcp.json 配置读写 REST。瘦 Controller —— 业务在 AgentService /
 * McpService，本类只做参数装配、agentId 越权校验前置（`findOrThrow`）与转发。
 */
@ApiTags("agents")
@Controller("api/agents")
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly agentCtx: AgentContextService,
    private readonly config: MeshbotConfigService,
    private readonly mcp: McpService,
    private readonly account: AccountContextService,
  ) {}

  /** 当前账号 —— REST 请求已由鉴权拦截器压过账号上下文，这里直接取即可。 */
  private currentAccount(): string {
    return this.account.getOrThrow();
  }

  @Get()
  @ApiOperation({ summary: "列出当前账号的全部 Agent" })
  @ApiOkResponse({
    description: "Agent 列表",
    type: AgentViewDto,
    isArray: true,
  })
  async list(): Promise<AgentView[]> {
    const agents = await this.agents.list();
    return agents.map(toAgentView);
  }

  @Post()
  @ApiOperation({ summary: "创建 Agent" })
  @ApiBody({ type: AgentCreateDto })
  @ApiOkResponse({ description: "创建成功", type: AgentViewDto })
  async create(@Body() body: AgentCreateDto): Promise<AgentView> {
    const created = await this.agents.create(body);
    return toAgentView(created);
  }

  @Patch(":id")
  @ApiOperation({ summary: "更新 Agent（只覆盖传入字段）" })
  @ApiBody({ type: AgentUpdateDto })
  @ApiOkResponse({ description: "更新成功", type: AgentViewDto })
  async update(
    @Param("id") id: string,
    @Body() body: AgentUpdateDto,
  ): Promise<AgentView> {
    const updated = await this.agents.update(id, body);
    return toAgentView(updated);
  }

  @Delete(":id")
  @ApiOperation({
    summary: "删除 Agent（连同其全部会话、记忆、工作区一起清掉；至少保留一个）",
  })
  @ApiOkResponse({ description: "已删除" })
  async remove(@Param("id") id: string): Promise<void> {
    await this.agents.removeWithData(id);
    await this.mcp.teardownAgent(this.currentAccount(), id);
  }

  @Post(":id/duplicate")
  @ApiOperation({
    summary: "复制 Agent 的配置（不复制记忆/工作区/会话/MCP 配置）",
  })
  @ApiOkResponse({ description: "复制成功，返回新 Agent", type: AgentViewDto })
  async duplicate(@Param("id") id: string): Promise<AgentView> {
    const copy = await this.agents.duplicate(id);
    return toAgentView(copy);
  }

  @Get(":id/mcp")
  @ApiOperation({ summary: "读取该 Agent 的 mcp.json（不存在返回空配置）" })
  @ApiOkResponse({ description: "mcp.json 原始文本", type: McpRawDto })
  async getMcp(@Param("id") id: string): Promise<{ raw: string }> {
    await this.agents.findOrThrow(id);
    return this.agentCtx.run(id, () => {
      const mcpPath = this.config.getMcpConfigPath();
      const raw = existsSync(mcpPath)
        ? readFileSync(mcpPath, "utf8")
        : '{\n  "mcpServers": {}\n}\n';
      return { raw };
    });
  }

  @Put(":id/mcp")
  @ApiOperation({
    summary: "写入该 Agent 的 mcp.json（Zod 校验后落盘并失效运行态）",
  })
  @ApiBody({ type: McpRawDto })
  @ApiOkResponse({ description: "已写入" })
  async putMcp(
    @Param("id") id: string,
    @Body() body: McpRawDto,
  ): Promise<void> {
    await this.agents.findOrThrow(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.raw);
    } catch (err) {
      throw new BadRequestException(
        `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = McpConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new BadRequestException(`配置校验失败：${result.error.message}`);
    }
    this.agentCtx.run(id, () => {
      writeFileSync(this.config.getMcpConfigPath(), body.raw, "utf8");
    });
    // 让运行态失效——下次 run 时 ensureAgent 会按新配置重建 client。
    await this.mcp.teardownAgent(this.currentAccount(), id);
  }
}
