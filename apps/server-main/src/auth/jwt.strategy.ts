import { Inject, Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";

export const JWT_MAIN_STRATEGY_NAME = "jwt-main";

export interface JwtMainPayload {
  userId: string;
  email: string;
  /** 当前活跃组织 id；未加入任何组织时为 null */
  orgId: string | null;
}

/**
 * server-main 独立 JWT Strategy（与 server-agent 的 "jwt" 隔离），
 * Strategy 名 `"jwt-main"`。secret 从强类型 AppConfig 读取，不允许默认兜底。
 */
@Injectable()
export class JwtMainStrategy extends PassportStrategy(
  Strategy,
  JWT_MAIN_STRATEGY_NAME,
) {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.jwt.secret,
    });
  }

  validate(payload: JwtMainPayload): JwtMainPayload {
    return {
      userId: payload.userId,
      email: payload.email,
      orgId: payload.orgId ?? null,
    };
  }
}
