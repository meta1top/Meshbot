import { AccountContextService } from "@meshbot/agent";
import type { HistoryResponse, SessionSummary } from "@meshbot/types-agent";
import { Controller, Get, Param, Query } from "@nestjs/common";

import { RemoteDeviceQueryService } from "../cloud/remote-device-query.service";

/**
 * L2c：向本地 server-agent 发起「查在线远程设备会话 / 历史」的 HTTP 入口。
 * 委托 RemoteDeviceQueryService 经 relay 发起跨设备查询，等待响应回流。
 */
@Controller("api")
export class RemoteDeviceController {
  constructor(
    private readonly query: RemoteDeviceQueryService,
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
}
