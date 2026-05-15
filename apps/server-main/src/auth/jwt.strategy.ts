import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

export const JWT_MAIN_STRATEGY_NAME = "jwt-main";

export interface JwtMainPayload {
  userId: string;
  email: string;
}

/**
 * server-main 独立 JWT Strategy（与 server-agent 的 "jwt" 隔离），
 * Strategy 名 `"jwt-main"`。secret 从 env 强制读取，不允许默认兜底。
 */
@Injectable()
export class JwtMainStrategy extends PassportStrategy(
  Strategy,
  JWT_MAIN_STRATEGY_NAME,
) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_SECRET"),
    });
  }

  validate(payload: JwtMainPayload): JwtMainPayload {
    return { userId: payload.userId, email: payload.email };
  }
}
