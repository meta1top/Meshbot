import { ConflictException, UnauthorizedException } from "@nestjs/common";

/**
 * server-main 业务错误抛出工具（最小集，仅覆盖注册 / 登录示范）。
 *
 * 约定：错误 message 是 i18n key（如 `"auth.emailAlreadyExists"`）。前端用
 * `Accept-Language` / `x-lang` 控制翻译；目前 nestjs-i18n 不自动翻译 throw 出来的
 * exception message —— 待 meshbot 真业务起来后再统一封装 AppError + i18n filter。
 *
 * key 必须与 `apps/server-main/i18n/{zh,en}/auth.json` 同步。
 */
export const MainErrorKeys = {
  emailAlreadyExists: "auth.emailAlreadyExists",
  invalidCredentials: "auth.invalidCredentials",
} as const;

export type MainErrorKey = keyof typeof MainErrorKeys;

/** 抛 i18n-key 业务错误，自动选合适的 HTTP 状态码。 */
export function throwMainError(key: MainErrorKey): never {
  const message = MainErrorKeys[key];
  if (key === "emailAlreadyExists") throw new ConflictException(message);
  throw new UnauthorizedException(message);
}
