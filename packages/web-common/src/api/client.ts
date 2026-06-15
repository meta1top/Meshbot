import axios, {
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";

const TOKEN_KEY = "meshbot_access_token";

const DEFAULT_API_URL = "http://127.0.0.1:3100";

function resolveBaseURL(): string {
  if (typeof window === "undefined") return DEFAULT_API_URL;
  const { protocol, hostname } = window.location;
  if (protocol === "http:" || protocol === "https:") {
    const apiHost =
      hostname === "localhost" || hostname === "[::1]" ? "127.0.0.1" : hostname;
    return `${protocol}//${apiHost}:3100`;
  }
  return DEFAULT_API_URL;
}

export function getBrowserApiBaseUrl(): string {
  return resolveBaseURL();
}

/**
 * 云端 / 本地业务错误（envelope `success:false`）。
 *
 * 按约定（见 `libs/common` errors/error-code.ts）业务错误走 HTTP 200 +
 * envelope `success:false`，故不会触发 axios 的错误分支，而是由
 * `unwrapEnvelope` 在成功拦截器内识别并抛出。携带云端已翻译的 `message`
 * 与业务 `code`，调用方据 `Error.message` 展示、必要时按 `code` 分支处理。
 */
class ApiError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/**
 * 解包 server 端统一响应 envelope。
 *
 * server 全局 ResponseInterceptor 把成功响应包成
 * `{ success, code, message, data, ... }`。识别该结构（同时含 success 与
 * data 字段）后：
 * - `success:false`（业务错误，按约定走 HTTP 200）→ 抛 `ApiError`，
 *   携带云端 `message`/`code`，由调用方展示；
 * - `success:true` → 取内层 `data`（可能合法为 null，如 void 端点）。
 * 不含 success+data 的响应（@SkipResponseEnvelope 路由 / 裸响应）原样返回。
 *
 * 约定：ResponseInterceptor 是唯一产生 `{success, data}` 包装的层；业务 DTO
 * 不应同时含 success + data 字段，否则会被误解包。
 *
 * 返回 `unknown` —— 这是运行时转换，调用方经 `apiClient.get<T>()` 声明的
 * 泛型类型不参与此处校验。
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (
    body !== null &&
    typeof body === "object" &&
    "success" in body &&
    "data" in body
  ) {
    const env = body as {
      success: unknown;
      code?: unknown;
      message?: unknown;
      data: unknown;
    };
    if (env.success === false) {
      const message =
        typeof env.message === "string" && env.message ? env.message : "";
      const code = typeof env.code === "number" ? env.code : undefined;
      throw new ApiError(message, code);
    }
    return env.data;
  }
  return body;
}

export function createApiClient(baseURL?: string): AxiosInstance {
  const client = axios.create({
    baseURL: baseURL ?? resolveBaseURL(),
    timeout: 30000,
    headers: { "Content-Type": "application/json" },
  });

  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    if (typeof window !== "undefined") {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      response.data = unwrapEnvelope(response.data);
      return response;
    },
    (error) => {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        if (typeof window !== "undefined") {
          localStorage.removeItem(TOKEN_KEY);
          const currentPath = window.location.pathname;
          if (currentPath !== "/login" && currentPath !== "/setup") {
            window.location.href = "/login";
          }
        }
      }
      return Promise.reject(error);
    },
  );

  return client;
}

export const apiClient = createApiClient();

export function setAccessToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
