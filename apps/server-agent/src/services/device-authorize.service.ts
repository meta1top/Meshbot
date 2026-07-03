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
import { resolveMeshbotDir } from "../utils/meshbot-dir";
import { PREFERRED_PORT } from "../utils/resolve-port";
import { AUTH_EVENTS } from "./auth.events";
import { CloudIdentityService } from "./cloud-identity.service";

interface PendingAuth {
  verifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 10;

/** 浏览器授权登录编排：start → (浏览器) → callback/粘贴码 → exchange → 本地登录完成。 */
@Injectable()
export class DeviceAuthorizeService {
  private readonly pending = new Map<string, PendingAuth>();
  private readonly completed = new Map<string, string>();

  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly runtime: AccountRuntimeRegistry,
    private readonly jwt: JwtService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 发起授权：返回浏览器要打开的云端授权页 URL。 */
  async start(): Promise<{ requestId: string; authorizeUrl: string }> {
    this.evictStale();
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
    const p = this.pending.get(requestId);
    if (!p) throw new AppError(AgentErrorCode.AUTH_NO_PENDING_REQUEST);
    const ex = await this.cloud.post<DeviceAuthExchangeResult>(
      "/api/device-auth/exchange",
      { requestId, userCode, codeVerifier: p.verifier },
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
    this.completed.set(requestId, access_token);
    this.emitter.emit(AUTH_EVENTS.authorized, { cloudUserId: ex.user.id });
    return { access_token };
  }

  /** 手动粘贴码（SSH/回调失败场景）：对最新一条 pending 兑换。 */
  async completeByCode(userCode: string): Promise<{ access_token: string }> {
    const latest = [...this.pending.entries()].sort(
      (a, b) => b[1].createdAt - a[1].createdAt,
    )[0];
    if (!latest) throw new AppError(AgentErrorCode.AUTH_NO_PENDING_REQUEST);
    return this.complete(latest[0], userCode);
  }

  /** 前端轮询取本地 token（一次性）。 */
  async poll(
    requestId: string,
  ): Promise<{ status: "pending" } | { status: "done"; access_token: string }> {
    const token = this.completed.get(requestId);
    if (!token) return { status: "pending" };
    this.completed.delete(requestId);
    return { status: "done", access_token: token };
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
    return `${process.env.USER ?? "meshbot"}@${os.hostname()}`;
  }

  /** 清过期 pending；容量超限时淘汰最旧一条。 */
  private evictStale(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    }
    while (this.pending.size >= PENDING_MAX) {
      const oldest = [...this.pending.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      )[0];
      this.pending.delete(oldest[0]);
    }
  }
}
