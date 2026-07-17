import type {
  DeviceQueryKind,
  DeviceQueryRequestInput,
  DeviceQueryResponse,
} from "@meshbot/types";
import { clientSnowflakeId } from "../utils/snowflake";

/** deviceQuery 往返默认超时：10s（浏览器直连场景，比 server-agent 侧 8s 更宽松——多一跳云网关）。 */
const DEFAULT_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** `DeviceQueryResponse.reason` → 用户可读错误文案（ok:false 语义化报错）。 */
const REASON_TEXT: Record<
  NonNullable<DeviceQueryResponse["reason"]>,
  string
> = {
  offline: "目标设备当前离线",
  cross_account: "目标设备不属于当前账号",
  error: "远程查询失败",
};

/**
 * L2c/L3 浏览器侧：deviceQuery 往返封装（correlationId 生成 + 超时 + 响应匹配）。
 * 纯逻辑（无 socket 依赖，emit 由调用方注入），镜像 server-agent
 * `RemoteDeviceQueryService` 的 pending-map 范式，供 web-main `session-transport.ts`
 * 复用，并可脱离真实 socket 单测（超时 / correlationId 错配 / ok:false 拒绝语义）。
 *
 * 与服务端版本的差异：correlationId 用客户端雪花（`clientSnowflakeId`）而非
 * `randomBytes`——浏览器侧没有 node:crypto，且雪花本身单调不减、单节点免冲突，
 * 复用现成生成器不必再引入额外依赖。
 */
export class DeviceQueryClient {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly genId: () => string;

  constructor(opts?: { timeoutMs?: number; genId?: () => string }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.genId = opts?.genId ?? clientSnowflakeId;
  }

  /**
   * 发起一次查询：生成 correlationId → 调用方注入的 `emit` 发出请求
   * （真实场景为 `socket.emit(IM_WS_EVENTS.deviceQueryRequest, req)`）→
   * 等待 {@link settle} 按 correlationId 回填。
   *
   * 超时（默认 10s）→ reject；`emit` 同步抛错（如 socket 未连接）→ 立即 reject
   * 且清理 pending，不泄漏定时器。
   */
  async query(
    emit: (req: DeviceQueryRequestInput) => void,
    targetAgentId: string,
    kind: DeviceQueryKind,
    params: DeviceQueryRequestInput["params"] = {},
  ): Promise<unknown> {
    const correlationId = this.genId();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error("远程查询超时（目标设备无响应）"));
      }, this.timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer });
    });
    try {
      emit({ correlationId, targetAgentId, kind, params });
    } catch (e) {
      this.clear(correlationId);
      throw e;
    }
    return promise;
  }

  /**
   * socket 收到 `deviceQueryResponse` 时调用；correlationId 未登记（错配 /
   * 已超时 / 非本客户端发起）静默忽略，不抛错。
   */
  settle(res: DeviceQueryResponse): void {
    const entry = this.pending.get(res.correlationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(res.correlationId);
    if (res.ok) {
      entry.resolve(res.data);
      return;
    }
    entry.reject(
      new Error((res.reason && REASON_TEXT[res.reason]) || "远程查询失败"),
    );
  }

  /** 清理指定 correlationId 的挂起项（`emit` 失败等场景下防泄漏）。 */
  private clear(correlationId: string): void {
    const entry = this.pending.get(correlationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
  }
}
