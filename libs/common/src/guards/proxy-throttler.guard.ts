import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Proxy-aware ThrottlerGuard —— Phase 5 Track B3。
 *
 * 默认 NestJS `ThrottlerGuard` 用 `req.ip` 做限流键。在反向代理 / 负载均衡器
 * 后面，所有请求的 `req.ip` 都是网关 IP，导致所有用户共享同一桶（限流失效）。
 *
 * 本 guard 优先读 `x-forwarded-for`（首段 = 最初客户端 IP），回退 `req.ip`。
 *
 * 注册方式（server-* `app.module.ts`）：
 * ```ts
 * imports: [
 *   ThrottlerModule.forRoot([
 *     { name: "short", ttl: 1000, limit: 30 },
 *     ...
 *   ]),
 * ],
 * providers: [{ provide: APP_GUARD, useClass: ProxyThrottlerGuard }],
 * ```
 *
 * 端点限流：
 * ```ts
 * @Throttle({ short: { limit: 5, ttl: 60_000 } })
 * @Post("register") ...
 * ```
 */
@Injectable()
export class ProxyThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req.headers ?? {}) as Record<
      string,
      string | string[] | undefined
    >;
    const xfwd = headers["x-forwarded-for"];
    if (typeof xfwd === "string" && xfwd.length > 0) {
      // X-Forwarded-For: client, proxy1, proxy2 → 取首段
      return Promise.resolve(xfwd.split(",")[0].trim());
    }
    if (Array.isArray(xfwd) && xfwd[0]) {
      return Promise.resolve(xfwd[0].split(",")[0].trim());
    }
    const ip = (req as { ip?: string }).ip;
    return Promise.resolve(ip ?? "anon");
  }
}
