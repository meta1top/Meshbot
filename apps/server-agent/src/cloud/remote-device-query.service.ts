import { randomBytes } from "node:crypto";
import { AppError } from "@meshbot/common";
import type {
  DeviceQueryKind,
  DeviceQueryRequestInput,
  DeviceQueryResponse,
} from "@meshbot/types";
import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { ImRelayClientService } from "./im-relay-client.service";
import { IM_RELAY_EVENTS } from "./im-relay.events";

/** 单条挂起查询：resolve/reject 回调 + 超时定时器。 */
interface Pending {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * L2c A 侧：发起跨设备只读查询，按 correlationId 等待 relay 回流（镜像
 * ConfirmationService 的 pending-map + 超时 promise 范式）。
 *
 * relay 传输层保持纯净：本服务经 EventEmitter2 `@OnEvent` 订阅响应事件，
 * 不让 ImRelayClientService 反向依赖本服务（避免循环依赖）。
 */
@Injectable()
export class RemoteDeviceQueryService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly relay: ImRelayClientService) {}

  /**
   * 发起对目标设备的只读查询；超时 / 离线 / 跨账号 → reject AppError。
   *
   * @param cloudUserId   发起账号
   * @param targetDeviceId 目标设备 ID
   * @param kind          查询种类：sessions（列会话）| history（取历史）
   * @param params        查询参数（按 kind 而定）
   * @param timeoutMs     超时毫秒数，默认 8000
   */
  async query(
    cloudUserId: string,
    targetDeviceId: string,
    kind: DeviceQueryKind,
    params: DeviceQueryRequestInput["params"],
    timeoutMs = 8000,
  ): Promise<unknown> {
    const correlationId = randomBytes(16).toString("hex");
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new AppError(AgentErrorCode.REMOTE_QUERY_TIMEOUT));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(correlationId, { resolve, reject, timer });
    });
    try {
      this.relay.emitDeviceQuery(cloudUserId, {
        correlationId,
        targetDeviceId,
        kind,
        params,
      });
    } catch (e) {
      this.clear(correlationId);
      throw e;
    }
    return result;
  }

  /** relay 收到 device.query.response 时经本地事件回调，settle 对应 pending。 */
  @OnEvent(IM_RELAY_EVENTS.deviceQueryResponse)
  settle(res: DeviceQueryResponse): void {
    const entry = this.pending.get(res.correlationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(res.correlationId);
    if (res.ok) entry.resolve(res.data);
    else entry.reject(new AppError(AgentErrorCode.REMOTE_QUERY_UNAVAILABLE));
  }

  /** 清理指定 correlationId 的挂起项（emit 失败等场景下防泄漏）。 */
  private clear(correlationId: string): void {
    const entry = this.pending.get(correlationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
  }
}
