import { AccountContextService } from "@meshbot/lib-agent";
import type { HistoryResponse, SessionSummary } from "@meshbot/types-agent";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOperation,
} from "@nestjs/swagger";

import { RemoteDeviceQueryService } from "../cloud/remote-device-query.service";
import {
  RemoteRunService,
  type RemoteRunView,
} from "../cloud/remote-run.service";
import { RemoteWatchService } from "../cloud/remote-watch.service";
import {
  RemoteAnswerDto,
  RemoteConfirmDto,
  RemoteInterruptDto,
  RemoteRunDto,
  RemoteRunsQueryDto,
  RemotePatchSessionModelDto,
  RemoteWatchStartDto,
} from "../dto/remote-run.dto";

/**
 * L2c/L3：对某个「远程 Agent」（其他设备上已注册的 Agent，寻址主键为云端
 * agent.id）发起「查会话 / 历史」及「远程 run 发起 / 中断 / 确认 / 回答」的
 * HTTP 入口。路径参数 `:agentId` = 云端 agentId，委托 RemoteDeviceQueryService /
 * RemoteRunService 经 relay 定向下发到该 Agent 的宿主设备（网关 findActiveById
 * 解出宿主 deviceId + localAgentId）。
 */
@Controller("api")
export class RemoteAgentSessionController {
  constructor(
    private readonly query: RemoteDeviceQueryService,
    private readonly remoteRun: RemoteRunService,
    private readonly remoteWatch: RemoteWatchService,
    private readonly account: AccountContextService,
  ) {}

  /** 查目标远程 Agent 当前会话列表。 */
  @Get("remote-agents/:agentId/sessions")
  async sessions(@Param("agentId") agentId: string): Promise<SessionSummary[]> {
    const acct = this.account.getOrThrow();
    return (await this.query.query(
      acct,
      agentId,
      "sessions",
      {},
    )) as SessionSummary[];
  }

  /** 读目标远程 Agent 会话产物（≤2MB 内联 base64；超限返回 too-large 信号）。 */
  @Get("remote-agents/:agentId/artifact")
  async artifact(
    @Param("agentId") agentId: string,
    @Query("sessionId") sessionId: string,
    @Query("path") filePath: string,
  ): Promise<unknown> {
    const acct = this.account.getOrThrow();
    return this.query.query(acct, agentId, "artifact-file", {
      sessionId,
      filePath,
    });
  }

  /** 目标远程 Agent 大产物上传组织网盘（返回 fileId，本机换 presigned URL 预览）。 */
  @Post("remote-agents/:agentId/artifact/upload-drive")
  async artifactUploadDrive(
    @Param("agentId") agentId: string,
    @Body() dto: { sessionId: string; path: string },
  ): Promise<unknown> {
    const acct = this.account.getOrThrow();
    return this.query.query(acct, agentId, "artifact-upload-drive", {
      sessionId: dto.sessionId,
      filePath: dto.path,
    });
  }

  /** 查目标远程 Agent 某会话的历史消息（支持 before / limit 分页）。 */
  @Get("remote-agents/:agentId/sessions/:sessionId/history")
  async history(
    @Param("agentId") agentId: string,
    @Param("sessionId") sessionId: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ): Promise<HistoryResponse> {
    const acct = this.account.getOrThrow();
    return (await this.query.query(acct, agentId, "history", {
      sessionId,
      before,
      limit: limit
        ? Math.min(Math.max(1, Number(limit) || 50), 100)
        : undefined,
    })) as HistoryResponse;
  }

  /**
   * 发起对目标远程 Agent 的远程 run：streamId 长活订阅登记 + 经 relay 下发到
   * 宿主设备执行，B 的运行帧经 RemoteRunService 影子重发到本地会话总线，前端
   * 订阅返回的 streamId 对应会话（create 模式下由首帧回报）即可像看本地 run
   * 一样渲染。
   */
  @Post("remote-agents/:agentId/run")
  async run(
    @Param("agentId") agentId: string,
    @Body() dto: RemoteRunDto,
  ): Promise<{ streamId: string }> {
    return this.remoteRun.startRun(
      this.account.getOrThrow(),
      agentId,
      dto.mode,
      dto.sessionId ?? null,
      dto.content,
    );
  }

  /** 远程会话：切换会话绑定模型（经 device query 通道写对端 session）。 */
  @Patch("remote-agents/:agentId/sessions/:sessionId/model")
  @ApiOperation({ summary: "切换远程会话的模型配置" })
  async patchSessionModel(
    @Param("agentId") agentId: string,
    @Param("sessionId") sessionId: string,
    @Body() dto: RemotePatchSessionModelDto,
  ): Promise<SessionSummary> {
    return (await this.query.query(
      this.account.getOrThrow(),
      agentId,
      "patch-session-model",
      { sessionId, modelConfigId: dto.modelConfigId },
    )) as SessionSummary;
  }

  /** 中断目标远程 Agent 上指定 streamId 对应的远程 run。 */
  @Post("remote-agents/:agentId/run/interrupt")
  async interrupt(
    @Param("agentId") agentId: string,
    @Body() dto: RemoteInterruptDto,
  ): Promise<{ ok: true }> {
    this.remoteRun.sendControl(this.account.getOrThrow(), {
      streamId: dto.streamId,
      targetAgentId: agentId,
      sessionId: dto.sessionId,
      kind: "interrupt",
    });
    return { ok: true };
  }

  /**
   * 远程会话：提交工具确认（im_send / drive_share / drive_create_share）。
   * `dto.streamId`/`dto.watchId` 二选一（Task 16b：观察者用 watchId 应答别人
   * 发起的 run），原样透传给 `RemoteRunService.sendControl`——它接的
   * `AgentRunControlInput` 本就是双寻址类型，不需要额外分支。
   */
  @Post("remote-agents/:agentId/run/confirm")
  @ApiOperation({ summary: "远程工具确认" })
  confirm(
    @Param("agentId") agentId: string,
    @Body() dto: RemoteConfirmDto,
  ): { ok: true } {
    this.remoteRun.sendControl(this.account.getOrThrow(), {
      streamId: dto.streamId,
      watchId: dto.watchId,
      targetAgentId: agentId,
      sessionId: dto.sessionId,
      kind: "confirm",
      toolCallId: dto.toolCallId,
      decision: dto.decision,
      content: dto.content,
    });
    return { ok: true };
  }

  /**
   * 远程会话：提交 ask_question 回答。`dto.streamId`/`dto.watchId` 二选一，
   * 理由同 {@link RemoteAgentSessionController.confirm}。
   */
  @Post("remote-agents/:agentId/run/answer")
  @ApiOperation({ summary: "远程提问回答" })
  answer(
    @Param("agentId") agentId: string,
    @Body() dto: RemoteAnswerDto,
  ): { ok: true } {
    this.remoteRun.sendControl(this.account.getOrThrow(), {
      streamId: dto.streamId,
      watchId: dto.watchId,
      targetAgentId: agentId,
      sessionId: dto.sessionId,
      kind: "answer",
      toolCallId: dto.toolCallId,
      answers: dto.answers,
    });
    return { ok: true };
  }

  /** 查本机记录的某远程 Agent 当前活跃 run（按 streamId 或 sessionId 反查），供 create/刷新补齐配对。 */
  @Get("remote-agents/:agentId/runs")
  @ApiOperation({ summary: "查活跃远程 run 的 streamId↔sessionId" })
  runs(
    @Param("agentId") agentId: string,
    @Query() query: RemoteRunsQueryDto,
  ): RemoteRunView | null {
    if (query.streamId) return this.remoteRun.findRunByStreamId(query.streamId);
    return this.remoteRun.findRunBySession(agentId, query.sessionId as string);
  }

  /**
   * Task 18：web-agent 浏览器不直连云端，经本机 server-agent 代理发起对目标
   * 远程 Agent 的观察（`scope:"agent"` 订会话生命周期镜像 / `scope:"session"`
   * 订推理帧）。RemoteWatchService 经 relay 上行 `agent.watch.start` 并登记
   * watchId，回流帧按登记的 scope 分流下发（session → 影子桥；agent → 专属
   * 信封 `REMOTE_AGENT_EVENTS.sessionEvent`，见该服务类注释的分流规则）。
   */
  @Post("remote-agents/:agentId/watch")
  @ApiOperation({ summary: "发起对目标远程 Agent 的观察（web-agent 代理层）" })
  @ApiBody({ type: RemoteWatchStartDto })
  @ApiCreatedResponse({
    description: "观察已登记，返回 watchId",
    schema: { properties: { watchId: { type: "string" } } },
  })
  watch(
    @Param("agentId") agentId: string,
    @Body() dto: RemoteWatchStartDto,
  ): { watchId: string } {
    return this.remoteWatch.startWatch(
      this.account.getOrThrow(),
      agentId,
      dto.scope,
      dto.sessionId,
    );
  }

  /** 显式注销对目标远程 Agent 的观察（离开视图 / 关闭会话），经 relay 上行 `agent.watch.stop`。 */
  @Delete("remote-agents/:agentId/watch/:watchId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "注销对目标远程 Agent 的观察" })
  @ApiNoContentResponse({ description: "已注销" })
  unwatch(
    @Param("agentId") _agentId: string,
    @Param("watchId") watchId: string,
  ): void {
    this.remoteWatch.stopWatch(this.account.getOrThrow(), watchId);
  }
}
