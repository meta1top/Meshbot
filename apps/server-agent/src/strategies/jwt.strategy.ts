import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import { resolveMeshbotDir } from "../utils/meshbot-dir";

/**
 * 本地 JWT secret：env 显式指定优先；否则首启在 meshbot 数据目录生成随机
 * secret 并持久化（0600）。不再使用公开的硬编码默认值 —— 0.0.0.0 监听 +
 * 云端代理端点的组合下，公开默认值会让局域网任意主机可铸造本地 JWT。
 */
function loadOrCreateJwtSecret(): string {
  const fromEnv = process.env.MESHBOT_JWT_SECRET;
  if (fromEnv) return fromEnv;
  const dir = resolveMeshbotDir();
  const file = path.join(dir, "jwt-secret");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const JWT_SECRET = loadOrCreateJwtSecret();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET,
    });
  }

  validate(payload: { sub: string; email: string }) {
    return { id: payload.sub, email: payload.email };
  }
}
