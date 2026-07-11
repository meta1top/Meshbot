import { AccountContextService } from "@meshbot/lib-agent";
import type { HistoryResponse, SessionSummary } from "@meshbot/types-agent";
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";

import { RemoteDeviceQueryService } from "../cloud/remote-device-query.service";
import {
  RemoteRunService,
  type RemoteRunView,
} from "../cloud/remote-run.service";
import {
  RemoteAnswerDto,
  RemoteConfirmDto,
  RemoteInterruptDto,
  RemoteRunDto,
  RemoteRunsQueryDto,
  RemotePatchSessionModelDto,
} from "../dto/remote-run.dto";

/**
 * L2c/L3：向本地 server-agent 发起「查在线远程设备会话 / 历史」及「远程 run
 * 发起 / 中断」的 HTTP 入口。分别委托 RemoteDeviceQueryService / RemoteRunService
 * 经 relay 发起跨设备请求。
 */
@Controller("api")
export class RemoteDeviceController {
  constructor(
    private readonly query: RemoteDeviceQueryService,
    private readonly remoteRun: RemoteRunService,
    private readonly account: AccountContextService,
  ) {}

  /** 查目标设备当前会话列表。 */
  @Get("remote-devices/:id/sessions")
  async sessions(@Param("id") id: string): Promise<SessionSummary[]> {
    const acct = this.account.getOrThrow();
    return (await this.query.query(
      acct,
      id,
      "sessions",
      {},
    )) as SessionSummary[];
  }

  /** 查目标设备某会话的历史消息（支持 before / limit 分页）。 */
  @Get("remote-devices/:id/sessions/:sessionId/history")
  async history(
    @Param("id") id: string,
    @Param("sessionId") sessionId: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ): Promise<HistoryResponse> {
    const acct = this.account.getOrThrow();
    return (await this.query.query(acct, id, "history", {
      sessionId,
      before,
      limit: limit
        ? Math.min(Math.max(1, Number(limit) || 50), 100)
        : undefined,
    })) as HistoryResponse;
  }

  /**
   * 发起对目标设备的远程 run：streamId 长活订阅登记 + 经 relay 下发 B 侧执行，
   * B 的运行帧经 RemoteRunService 影子重发到本地会话总线，前端订阅返回的
   * streamId 对应会话（create 模式下由首帧回报）即可像看本地 run 一样渲染。
   */
  @Post("remote-devices/:id/run")
  async run(
    @Param("id") id: string,
    @Body() dto: RemoteRunDto,
  ): Promise<{ streamId: string }> {
    return this.remoteRun.startRun(
      this.account.getOrThrow(),
      id,
      dto.mode,
      dto.sessionId ?? null,
      dto.content,
    );
  }

  /** 中断目标设备上指定 streamId 对应的远程 run。 */
  /** 远程会话：切换会话绑定模型（经 device query 通道写对端 session）。 */
  @Patch("remote-devices/:id/sessions/:sessionId/model")
  @ApiOperation({ summary: "切换远程会话的模型配置" })
  async patchSessionModel(
    @Param("id") id: string,
    @Param("sessionId") sessionId: string,
    @Body() dto: RemotePatchSessionModelDto,
  ): Promise<SessionSummary> {
    return (await this.query.query(
      this.account.getOrThrow(),
      id,
      "patch-session-model",
      { sessionId, modelConfigId: dto.modelConfigId },
    )) as SessionSummary;
  }

  @Post("remote-devices/:id/run/interrupt")
  async interrupt(
    @Param("id") id: string,
    @Body() dto: RemoteInterruptDto,
  ): Promise<{ ok: true }> {
    this.remoteRun.sendControl(this.account.getOrThrow(), {
      streamId: dto.streamId,
      targetDeviceId: id,
      sessionId: dto.sessionId,
      kind: "interrupt",
    });
    return { ok: true };
  }

  /** 远程会话：提交工具确认（im_send / drive_share / drive_create_share）。 */
  @Post("remote-devices/:id/run/confirm")
  @ApiOperation({ summary: "远程工具确认" })
  confirm(
    @Param("id") id: string,
    @Body() dto: RemoteConfirmDto,
  ): { ok: true } {
    this.remoteRun.sendControl(this.account.getOrThrow(), {
      streamId: dto.streamId,
      targetDeviceId: id,
      sessionId: dto.sessionId,
      kind: "confirm",
      toolCallId: dto.toolCallId,
      decision: dto.decision,
      content: dto.content,
    });
    return { ok: true };
  }

  /** 远程会话：提交 ask_question 回答。 */
  @Post("remote-devices/:id/run/answer")
  @ApiOperation({ summary: "远程提问回答" })
  answer(@Param("id") id: string, @Body() dto: RemoteAnswerDto): { ok: true } {
    this.remoteRun.sendControl(this.account.getOrThrow(), {
      streamId: dto.streamId,
      targetDeviceId: id,
      sessionId: dto.sessionId,
      kind: "answer",
      toolCallId: dto.toolCallId,
      answers: dto.answers,
    });
    return { ok: true };
  }

  /** 查本机记录的某远程设备当前活跃 run（按 streamId 或 sessionId 反查），供 create/刷新补齐配对。 */
  @Get("remote-devices/:id/runs")
  @ApiOperation({ summary: "查活跃远程 run 的 streamId↔sessionId" })
  runs(
    @Param("id") id: string,
    @Query() query: RemoteRunsQueryDto,
  ): RemoteRunView | null {
    if (query.streamId) return this.remoteRun.findRunByStreamId(query.streamId);
    return this.remoteRun.findRunBySession(id, query.sessionId as string);
  }
}
