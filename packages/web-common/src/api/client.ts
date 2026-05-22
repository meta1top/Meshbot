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
 * 解包 server 端统一响应 envelope。
 *
 * server 全局 ResponseInterceptor 把成功响应包成
 * `{ success, code, message, data, ... }`。识别该结构（同时含 success 与
 * data 字段）则取内层 `data`；否则（@SkipResponseEnvelope 路由 / 裸响应）原样返回。
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (
    body !== null &&
    typeof body === "object" &&
    "success" in body &&
    "data" in body
  ) {
    return (body as { data: unknown }).data;
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
