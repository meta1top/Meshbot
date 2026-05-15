import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import type { JwtMainPayload } from "./jwt.strategy";

/**
 * 从 request 中提取 JwtStrategy.validate 返回的 user payload。
 *
 * @public-api 框架基线导出：Phase 3 的注册 / 登录示范没有 protected endpoint
 * 用到它，但 meshbot 真业务接到 server-main 后必然会需要。保留以避免后续重复造轮子。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtMainPayload => {
    const req = ctx.switchToHttp().getRequest<{ user: JwtMainPayload }>();
    return req.user;
  },
);

export type { JwtMainPayload as CurrentUserPayload } from "./jwt.strategy";
