import type { AccountContextService } from "@meshbot/lib-agent";
import type { EventEmitter2 } from "@nestjs/event-emitter";

import { AUTH_EVENTS } from "./auth.events";
import type { CloudIdentityService } from "./cloud-identity.service";

/**
 * 构造 CloudClientService 的 unauthorized（云端 401）回调：
 * 标记当前账号已登出（setup-status 落回 needs-login），并发
 * `AUTH_EVENTS.reauthRequired` 供 EventsGateway 转发前端提示重新授权。
 *
 * 401 发生在请求的账号 ALS 上下文内，emit 同步执行不掉出上下文——
 * EventsGateway.emitEnvelope 依赖该不变量把事件路由到 `acct:<id>` 房间。
 * 无上下文（后台路径）时静默跳过。
 *
 * 从 auth.module 工厂闭包提出为独立函数，便于单测固化上述行为。
 */
export function buildUnauthorizedHandler(
  account: AccountContextService,
  identity: CloudIdentityService,
  emitter: EventEmitter2,
): () => void {
  return () => {
    const id = account.get();
    if (id) {
      void identity.setLoggedOut(id);
      emitter.emit(AUTH_EVENTS.reauthRequired, { cloudUserId: id });
    }
  };
}
