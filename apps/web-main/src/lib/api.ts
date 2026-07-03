import axios from "axios";
import { clearMainToken, getMainToken } from "./auth-storage";

/** 业务错误（envelope `success:false`）。code 对应后端 `MainErrorCode`。 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 无需登录即可访问的路径前缀——401 时不跳转，避免死循环。 */
const PUBLIC_PATHS = ["/login", "/register", "/authorize", "/share"];

/**
 * 云协同前端独立 axios 实例。与 `@meshbot/web-common` 的 apiClient（agent 域）
 * 完全隔离：baseURL、token key、401 处理策略都不同，不可混用。
 */
export const mainApi = axios.create({
  baseURL: process.env.NEXT_PUBLIC_SERVER_MAIN_URL ?? "",
});

mainApi.interceptors.request.use((config) => {
  const token = getMainToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

mainApi.interceptors.response.use(
  (res) => {
    const body = res.data as {
      success?: boolean;
      data?: unknown;
      message?: string;
      code?: number;
    };
    if (body && typeof body === "object" && "success" in body) {
      if (!body.success)
        throw new ApiError(body.message ?? "request failed", body.code ?? -1);
      res.data = body.data;
    }
    return res;
  },
  (err) => {
    if (err.response?.status === 401 && typeof window !== "undefined") {
      clearMainToken();
      const path = window.location.pathname;
      if (!PUBLIC_PATHS.some((p) => path.startsWith(p))) {
        window.location.href = `/login?next=${encodeURIComponent(path + window.location.search)}`;
      }
    }
    return Promise.reject(err);
  },
);
