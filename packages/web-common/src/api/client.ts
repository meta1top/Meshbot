import axios, {
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";

const TOKEN_KEY = "meshbot_access_token";

/** 多账号 store 的 localStorage key。值为 JSON 序列化的 AccountsStore。 */
const ACCOUNTS_KEY = "meshbot_accounts";

/**
 * 解析后端（server-agent）基址。
 *
 * - 开发：web-agent 跑在独立 Next dev server，与 server-agent 跨端口，
 *   通过构建期变量 `NEXT_PUBLIC_SERVER_AGENT_URL` 显式指向后端。
 * - 生产：前端由 server-agent 同源伺服（静态导出不带该变量），用当前页面
 *   `window.location.origin`，API / WS 全部相对到伺服源——后端端口随便变都成立。
 * - SSR / 构建期（无 window 且无 dev 变量）：返回空串（静态导出下不会发起真实请求）。
 */
function resolveBaseURL(): string {
  const devUrl = process.env.NEXT_PUBLIC_SERVER_AGENT_URL;
  if (devUrl) return devUrl;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
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

/**
 * 清除活跃 token 并清空全部账号（全量登出）。
 * 同时移除 ACCOUNTS_KEY，使多账号 store 回到初始状态。
 */
export function clearAccessToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACCOUNTS_KEY);
}

/** 返回活跃账号的 token（localStorage[TOKEN_KEY]），SSR 安全。 */
export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// 多账号 token store
// ---------------------------------------------------------------------------

/** 存储在 localStorage 中的多账号内部结构。 */
interface AccountsStore {
  activeId: string | null;
  accounts: Record<
    string,
    { token: string; email?: string; displayName?: string }
  >;
}

/** `listAccounts()` 返回的公开账号条目，active 标志由 activeId 导出。 */
export interface AccountEntry {
  cloudUserId: string;
  email?: string;
  displayName?: string;
  active: boolean;
}

/** 从 localStorage 读取 store；解析失败或不存在时视为空 store。 */
function loadStore(): AccountsStore {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return { activeId: null, accounts: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "accounts" in parsed &&
      typeof (parsed as { accounts: unknown }).accounts === "object"
    ) {
      return parsed as AccountsStore;
    }
  } catch {
    // malformed JSON → fall through
  }
  return { activeId: null, accounts: {} };
}

/** 将 store 写回 localStorage。 */
function saveStore(store: AccountsStore): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(store));
}

/**
 * 将指定账号 upsert 到 store 并设为活跃。
 * 同时写入 `meshbot_access_token`，axios 拦截器无需额外配置即可使用该 token。
 * SSR 环境下为 no-op。
 */
export function addAccount(
  cloudUserId: string,
  token: string,
  meta?: { email?: string; displayName?: string },
): void {
  if (typeof window === "undefined") return;
  const store = loadStore();
  store.accounts[cloudUserId] = { token, ...meta };
  store.activeId = cloudUserId;
  saveStore(store);
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * 切换活跃账号。仅当 store 中存在该 cloudUserId 时生效，同步更新 TOKEN_KEY。
 * SSR 环境下为 no-op。
 */
export function setActiveAccount(cloudUserId: string): void {
  if (typeof window === "undefined") return;
  const store = loadStore();
  const entry = store.accounts[cloudUserId];
  if (!entry) return;
  store.activeId = cloudUserId;
  saveStore(store);
  localStorage.setItem(TOKEN_KEY, entry.token);
}

/**
 * 返回全部已知账号列表，active 标志由 activeId 导出。SSR 返回空数组。
 */
export function listAccounts(): AccountEntry[] {
  if (typeof window === "undefined") return [];
  const store = loadStore();
  return Object.entries(store.accounts).map(([cloudUserId, data]) => ({
    cloudUserId,
    email: data.email,
    displayName: data.displayName,
    active: cloudUserId === store.activeId,
  }));
}

/** 返回当前活跃账号的 cloudUserId；SSR 或无活跃账号时返回 null。 */
export function getActiveAccountId(): string | null {
  if (typeof window === "undefined") return null;
  return loadStore().activeId;
}

/**
 * 从 store 中移除指定账号。
 * - 若被移除账号是活跃账号，从剩余账号中任选一个作为新活跃并同步 TOKEN_KEY。
 * - 若无剩余账号，清空 activeId 并删除 TOKEN_KEY（相当于登出）。
 * SSR 环境下为 no-op。
 */
export function removeAccount(cloudUserId: string): void {
  if (typeof window === "undefined") return;
  const store = loadStore();
  if (!(cloudUserId in store.accounts)) return;
  delete store.accounts[cloudUserId];
  if (store.activeId === cloudUserId) {
    const remaining = Object.keys(store.accounts);
    if (remaining.length > 0) {
      const nextId = remaining[0];
      store.activeId = nextId;
      localStorage.setItem(TOKEN_KEY, store.accounts[nextId].token);
    } else {
      store.activeId = null;
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  saveStore(store);
}
