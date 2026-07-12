import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DeviceAuthExchangeResult,
  DeviceAuthStartResult,
} from "@meshbot/types";
import { AppError } from "@meshbot/common";
import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";

import { AccountRuntimeRegistry } from "../account/account-runtime.registry";
import { CloudClientService } from "../cloud/cloud-client.service";
import type { CloudProfileData } from "../cloud/cloud.types";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { resolveMachineId } from "../utils/machine-id";
import { isPackaged, resolveMeshbotDir } from "../utils/meshbot-dir";
import { PREFERRED_PORT } from "../utils/resolve-port";
import { AUTH_EVENTS } from "./auth.events";
import { CloudIdentityService } from "./cloud-identity.service";

interface PendingAuth {
  verifier: string;
  createdAt: number;
}

interface CompletedAuth {
  token: string;
  createdAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 10;

/** 浏览器授权登录编排：start → (浏览器) → callback/粘贴码 → exchange → 本地登录完成。 */
@Injectable()
export class DeviceAuthorizeService {
  private readonly pending = new Map<string, PendingAuth>();
  private readonly completed = new Map<string, CompletedAuth>();
  /** 兑换中的 requestId：拦截同 id 并发 complete（回调与手动粘贴竞速 / 重定向页双击）。 */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly runtime: AccountRuntimeRegistry,
    private readonly jwt: JwtService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 发起授权：返回浏览器要打开的云端授权页 URL。 */
  async start(): Promise<{ requestId: string; authorizeUrl: string }> {
    this.evictStale(this.pending);
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("hex");
    const result = await this.cloud.post<DeviceAuthStartResult>(
      "/api/device-auth/start",
      {
        deviceName: this.deviceName(),
        platform: process.platform,
        codeChallenge,
        redirectUri: `http://127.0.0.1:${this.actualPort()}/api/auth/callback`,
      },
    );
    this.pending.set(result.requestId, { verifier, createdAt: Date.now() });
    return { requestId: result.requestId, authorizeUrl: result.verifyUrl };
  }

  /** 用一次性授权码完成兑换与本地登录。 */
  async complete(
    requestId: string,
    userCode: string,
  ): Promise<{ access_token: string }> {
    // 并发守卫：同 requestId 的第二次 complete 直接拒绝（云端 exchange
    // 有锁 + consumed 兜底，这里是本地的廉价前置拦截）。
    if (this.inFlight.has(requestId)) {
      throw new AppError(AgentErrorCode.AUTH_NO_PENDING_REQUEST);
    }
    const p = this.pending.get(requestId);
    if (!p) throw new AppError(AgentErrorCode.AUTH_NO_PENDING_REQUEST);
    this.inFlight.add(requestId);
    try {
      const ex = await this.cloud.post<DeviceAuthExchangeResult>(
        "/api/device-auth/exchange",
        {
          requestId,
          userCode,
          codeVerifier: p.verifier,
          machineId: resolveMachineId(),
        },
      );
      this.pending.delete(requestId);
      const profile = await this.cloud.get<CloudProfileData>(
        "/api/auth/profile",
        ex.deviceToken,
      );
      await this.identity.upsert({
        cloudUserId: ex.user.id,
        email: ex.user.email,
        displayName: ex.user.displayName,
        deviceToken: ex.deviceToken,
        cloudToken: "",
        cloudTokenExpiresAt: null,
        orgId: profile.activeOrg?.id ?? null,
        orgName: profile.activeOrg?.name ?? null,
        role: profile.activeOrg?.role ?? null,
      });
      await this.runtime.createRuntime(ex.user.id);
      const access_token = this.jwt.sign({
        sub: ex.user.id,
        email: ex.user.email,
      });
      this.evictStale(this.completed);
      this.completed.set(requestId, {
        token: access_token,
        createdAt: Date.now(),
      });
      // emitAsync 等待监听器完成——ModelConfigSyncService 借此在登录响应返回前
      // 完成首次云端模型同步，桌面端拿到 token 时模型列表已就位（免手动刷新）。
      // 监听器异常不阻塞登录（同步失败有事件链/重连兜底）。
      await this.emitter
        .emitAsync(AUTH_EVENTS.authorized, { cloudUserId: ex.user.id })
        .catch(() => undefined);
      return { access_token };
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  /** 手动粘贴码（SSH/回调失败场景）：对最新一条 pending 兑换。 */
  async completeByCode(userCode: string): Promise<{ access_token: string }> {
    const latest = [...this.pending.entries()].sort(
      (a, b) => b[1].createdAt - a[1].createdAt,
    )[0];
    if (!latest) throw new AppError(AgentErrorCode.AUTH_NO_PENDING_REQUEST);
    return this.complete(latest[0], userCode);
  }

  /** 前端轮询取本地 token（一次性；过期条目视同不存在）。 */
  async poll(
    requestId: string,
  ): Promise<{ status: "pending" } | { status: "done"; access_token: string }> {
    const entry = this.completed.get(requestId);
    if (!entry) return { status: "pending" };
    this.completed.delete(requestId);
    if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
      return { status: "pending" };
    }
    return { status: "done", access_token: entry.token };
  }

  /** 读 `<meshbotDir>/agent.port` 拿实际监听端口；读不到回退偏好端口。 */
  private actualPort(): number {
    try {
      const raw = readFileSync(
        path.join(resolveMeshbotDir(), "agent.port"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as { port?: number };
      if (parsed.port) return parsed.port;
    } catch {
      // 回退偏好端口
    }
    return PREFERRED_PORT;
  }

  private deviceName(): string {
    // dev 与打包版在同一台机器上是两台独立设备（machineId 加 dev- 前缀区分），
    // 但 user@hostname 相同、名字会撞。给 dev 追加 " (dev)" 后缀便于区分。
    const base = `${process.env.USER ?? "meshbot"}@${os.hostname()}`;
    return isPackaged() ? base : `${base} (dev)`;
  }

  /** 惰性清理：清过期条目；容量达上限时淘汰最旧，为即将写入的条目腾位。 */
  private evictStale(map: Map<string, { createdAt: number }>): void {
    const now = Date.now();
    for (const [id, v] of map) {
      if (now - v.createdAt > CACHE_TTL_MS) map.delete(id);
    }
    while (map.size >= CACHE_MAX) {
      const oldest = [...map.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      )[0];
      map.delete(oldest[0]);
    }
  }
}
