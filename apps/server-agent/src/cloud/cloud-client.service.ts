import { AppError, type ErrorCode } from "@meshbot/common";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AgentErrorCode } from "../errors/agent.error-codes";

/** 云端响应信封形状。 */
interface CloudEnvelope<T> {
  success: boolean;
  code: number;
  message?: string;
  data?: T;
}

/** 注入用 token：可被测试替换的 fetch。 */
export const CLOUD_FETCH = Symbol("CLOUD_FETCH");

/**
 * 云端 server-main 的 HTTP 客户端（方案 A）。
 * - 云端 token 由调用方传入（持久化在 cloud_identity，由上层服务取出）。
 * - 解信封：success=true 返回 data；success=false 把云端 code/message 透传为
 *   AppError（message 已是云端翻译好的文本，本地 i18n 未命中时按原文展示）。
 * - 网络异常 / 非 JSON → CLOUD_UNREACHABLE；HTTP 401 → 触发回调（清本地
 *   token）并抛 AUTH_UNAUTHORIZED。
 */
@Injectable()
export class CloudClientService {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private onUnauthorized?: () => Promise<void> | void;

  constructor(
    baseUrlOrConfig: string | ConfigService,
    @Optional() @Inject(CLOUD_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.baseUrl =
      typeof baseUrlOrConfig === "string"
        ? baseUrlOrConfig
        : baseUrlOrConfig.getOrThrow<string>("MESHBOT_CLOUD_URL");
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  /** 注册云端 401 处理器（token 失效 → 清本地身份 → 前端落回 needs-login）。 */
  setUnauthorizedHandler(handler: () => Promise<void> | void): void {
    this.onUnauthorized = handler;
  }

  /** POST 云端接口并解信封返回 data。 */
  async post<T>(path: string, body: unknown, token?: string): Promise<T> {
    return this.request<T>("POST", path, body, token);
  }

  /** GET 云端接口并解信封返回 data。 */
  async get<T>(path: string, token?: string): Promise<T> {
    return this.request<T>("GET", path, undefined, token);
  }

  /** DELETE 云端接口并解信封返回 data。 */
  async del<T>(path: string, token?: string): Promise<T> {
    return this.request<T>("DELETE", path, undefined, token);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    token?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AppError(AgentErrorCode.CLOUD_UNREACHABLE);
    }

    if (res.status === 401) {
      await this.onUnauthorized?.();
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }

    let envelope: CloudEnvelope<T>;
    try {
      envelope = (await res.json()) as CloudEnvelope<T>;
    } catch {
      throw new AppError(AgentErrorCode.CLOUD_UNREACHABLE);
    }

    if (envelope.success) {
      return envelope.data as T;
    }
    const cloudErr: ErrorCode = {
      code: envelope.code,
      message: envelope.message ?? "cloud error",
      httpStatus: 200,
    };
    throw new AppError(cloudErr);
  }
}
