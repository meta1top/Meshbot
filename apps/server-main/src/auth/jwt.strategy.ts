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
  /**
   * 设备 token 身份才有的字段（Task 8 落地设备 token 识别后由对应 Strategy/Guard
   * 填充）。当前 JwtMainStrategy 签发/校验的用户 JWT 恒为 undefined —— 依赖
   * device token 身份的端点（如 `POST /devices/switch-org`）据此判断 403。
   */
  deviceId?: string;
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
