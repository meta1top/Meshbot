import { AccountContextService } from "@meshbot/lib-agent";
import type { DeviceQueryResponse } from "@meshbot/types";
import { ForbiddenException, Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayDeviceQueryRequestEvent,
} from "../cloud/im-relay.events";
import { RemoteArtifactService } from "./remote-artifact.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/**
 * L2c B 侧：收到云端转发的跨设备查询请求，在发起方账号的 `account.run` scope
 * 内查本地会话数据，再经 {@link ImRelayClientService.emitDeviceQueryResponse}
 * 回发响应（best-effort，relay 未连接时静默丢弃——A 侧已有超时兜底）。
 *
 * 查询抛错（如 sessionId 不存在）→ 回 `ok:false, reason:"error"`，不让异常
 * 冒泡出 EventEmitter2 的事件处理器（否则会打进程未捕获异常日志）。
 *
 * 【Agent 作用域——安全命门】一设备多 Agent 下，本设备可能同时住着多个 Agent
 * 的会话，而 `forwarded.localAgentId`（网关按可信 CloudAgent 表解出）才是本次
 * 请求真正寻址的那一个。所有查询都必须按它收窄：`sessions` 只列该 Agent 的会话，
 * 带 sessionId 的 kind 一律先过 {@link assertSessionOwnedByAgent}。否则远端既能
 * 看到别的 Agent 的会话列表（点进去发消息还会被远程 run 的归属门控拒掉，报错
 * 原因驴唇不对马嘴），也能直接拿 sessionId 拉别的 Agent 的历史与产物。
 */
@Injectable()
export class RemoteQueryInboundService {
  constructor(
    private readonly sessions: SessionService,
    private readonly messages: SessionMessageService,
    private readonly artifacts: RemoteArtifactService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** relay 收到 device.query.request（云端转发）时触发；按 kind 查本地会话数据。 */
  @OnEvent(IM_RELAY_EVENTS.deviceQueryRequest)
  async onDeviceQueryRequest(
    evt: ImRelayDeviceQueryRequestEvent,
  ): Promise<void> {
    const { cloudUserId, forwarded } = evt;
    const base = {
      correlationId: forwarded.correlationId,
      requesterDeviceId: forwarded.requesterDeviceId,
    };
    try {
      await this.account.run(cloudUserId, async () => {
        const localAgentId = forwarded.localAgentId;
        const sessionId = forwarded.params.sessionId ?? "";
        let data: unknown;
        if (forwarded.kind === "sessions") {
          // 一设备多 Agent：只列本次寻址的那个 Agent 的会话，绝不返回同设备
          // 其他 Agent 的会话（越界 + 后续远程 run 必被归属门控拒绝）。
          data = await this.sessions.listByAgentSorted(localAgentId);
        } else if (forwarded.kind === "artifact-file") {
          // 跨设备产物预览：白名单（本会话 present_file 呈现过）+ 2MB 内联上限。
          await this.assertSessionOwnedByAgent(sessionId, localAgentId);
          data = await this.artifacts.read(
            sessionId,
            forwarded.params.filePath ?? "",
          );
        } else if (forwarded.kind === "artifact-upload-drive") {
          // 大文件路径：上传组织网盘，A 侧换 presigned URL 预览。
          await this.assertSessionOwnedByAgent(sessionId, localAgentId);
          data = await this.artifacts.uploadToDrive(
            sessionId,
            forwarded.params.filePath ?? "",
          );
        } else if (forwarded.kind === "patch-session-model") {
          // 写操作:改会话绑定模型。modelConfigId 是云端配置 id(本地行 id 与
          // 之同源,跨设备一致),SessionService.patch 内校验存在性与账号归属。
          await this.assertSessionOwnedByAgent(sessionId, localAgentId);
          data = await this.sessions.patch(sessionId, {
            modelConfigId: forwarded.params.modelConfigId,
          });
        } else {
          await this.assertSessionOwnedByAgent(sessionId, localAgentId);
          data = await this.messages.listPage(sessionId, {
            before: forwarded.params.before,
            limit: Math.min(Math.max(1, forwarded.params.limit ?? 50), 100),
          });
        }
        this.relay.emitDeviceQueryResponse(cloudUserId, {
          ...base,
          ok: true,
          data,
        } satisfies DeviceQueryResponse);
      });
    } catch {
      this.relay.emitDeviceQueryResponse(cloudUserId, {
        ...base,
        ok: false,
        reason: "error",
      });
    }
  }

  /**
   * 带 sessionId 的查询（history / artifact-* / patch-session-model）统一前置门控：
   * 该会话必须真实存在**且归属本次寻址的 localAgentId**，否则抛（外层转
   * `ok:false, reason:"error"`）。
   *
   * fail-closed：sessionId 或 localAgentId 缺失、会话查无、归属不符——一律拒绝。
   * 没有这道门，远端拿到任一 sessionId 就能跨 Agent 拉别的 Agent 的历史/产物，
   * 甚至改它的模型绑定（`patch-session-model` 是写操作）。
   */
  private async assertSessionOwnedByAgent(
    sessionId: string,
    localAgentId: string,
  ): Promise<void> {
    if (!sessionId || !localAgentId) {
      throw new ForbiddenException("缺少 sessionId / localAgentId");
    }
    const session = await this.sessions.findOrNull(sessionId);
    if (!session || session.agentId !== localAgentId) {
      throw new ForbiddenException("会话不属于本次寻址的 Agent");
    }
  }
}
