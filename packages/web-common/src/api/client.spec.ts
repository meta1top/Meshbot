import {
  addAccount,
  clearAccessToken,
  getAccessToken,
  getActiveAccountId,
  listAccounts,
  removeAccount,
  setActiveAccount,
  unwrapEnvelope,
} from "./client";

/**
 * unwrapEnvelope 单测。
 *
 * 约定（见 libs/common errors/error-code.ts）：业务错误走 HTTP 200 +
 * envelope `success:false`，前端按 `success` 字段统一判断。本函数即该判断的
 * 落点：`success:false` 必须抛出携带云端 message/code 的错误，调用方（如
 * login）才不会在失败时盲读 data。
 */
describe("unwrapEnvelope", () => {
  it("success:false 信封抛出携带 message 的错误", () => {
    expect(() =>
      unwrapEnvelope({
        success: false,
        code: 2002,
        message: "邮箱或密码错误",
        data: null,
      }),
    ).toThrow("邮箱或密码错误");
  });

  it("抛出的是 Error 实例（登录页据此取 message 展示）", () => {
    expect(() =>
      unwrapEnvelope({ success: false, code: 1, message: "x", data: null }),
    ).toThrow(Error);
  });

  it("抛出的错误携带云端 code", () => {
    let caught: unknown;
    try {
      unwrapEnvelope({ success: false, code: 2002, message: "x", data: null });
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: number }).code).toBe(2002);
  });

  it("success:true 信封解包返回内层 data", () => {
    expect(
      unwrapEnvelope({ success: true, code: 0, data: { access_token: "t" } }),
    ).toEqual({ access_token: "t" });
  });

  it("success:true 且 data 为 null（void 端点）原样返回 null", () => {
    expect(unwrapEnvelope({ success: true, code: 0, data: null })).toBeNull();
  });

  it("非信封响应（无 success/data 字段）原样返回", () => {
    expect(unwrapEnvelope({ id: 1, name: "x" })).toEqual({ id: 1, name: "x" });
  });
});

// ---------------------------------------------------------------------------
// 多账号 token store 单测
//
// 测试环境为 node（无 jsdom），需手动 stub globalThis.localStorage。
// 用 Map 模拟 Storage，在每个 describe 块 beforeEach 重置，保证用例隔离。
// ---------------------------------------------------------------------------

/** 极简 localStorage stub，符合 Storage 接口的子集。 */
function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };
}

describe("多账号 token store", () => {
  let originalWindow: typeof globalThis.window;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    // 确保 typeof window !== "undefined"（SSR 守卫跳过）
    originalWindow = globalThis.window;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (globalThis as any).window = {};
    originalLocalStorage = globalThis.localStorage;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (globalThis as any).localStorage = makeLocalStorage();
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (globalThis as any).window = originalWindow;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it("addAccount 将账号写入 store 并设为活跃，TOKEN_KEY 同步", () => {
    addAccount("u1", "tok-1", { email: "a@example.com" });

    expect(getAccessToken()).toBe("tok-1");
    expect(getActiveAccountId()).toBe("u1");

    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      cloudUserId: "u1",
      email: "a@example.com",
      active: true,
    });
  });

  it("addAccount 第二个账号后新账号成为活跃，旧账号 active:false", () => {
    addAccount("u1", "tok-1");
    addAccount("u2", "tok-2", { email: "b@example.com" });

    expect(getAccessToken()).toBe("tok-2");
    expect(getActiveAccountId()).toBe("u2");

    const accounts = listAccounts();
    expect(accounts).toHaveLength(2);
    const u1 = accounts.find((a) => a.cloudUserId === "u1");
    const u2 = accounts.find((a) => a.cloudUserId === "u2");
    expect(u1?.active).toBe(false);
    expect(u2?.active).toBe(true);
  });

  it("setActiveAccount 切换活跃账号并同步 TOKEN_KEY", () => {
    addAccount("u1", "tok-1");
    addAccount("u2", "tok-2");

    setActiveAccount("u1");

    expect(getAccessToken()).toBe("tok-1");
    expect(getActiveAccountId()).toBe("u1");

    const accounts = listAccounts();
    expect(accounts.find((a) => a.cloudUserId === "u1")?.active).toBe(true);
    expect(accounts.find((a) => a.cloudUserId === "u2")?.active).toBe(false);
  });

  it("setActiveAccount 对不存在的 ID 为 no-op", () => {
    addAccount("u1", "tok-1");
    setActiveAccount("nonexistent");

    expect(getActiveAccountId()).toBe("u1");
    expect(getAccessToken()).toBe("tok-1");
  });

  it("removeAccount 非活跃账号：仅从 store 移除，活跃不变", () => {
    addAccount("u1", "tok-1");
    addAccount("u2", "tok-2");
    // u2 是活跃
    removeAccount("u1");

    expect(getActiveAccountId()).toBe("u2");
    expect(getAccessToken()).toBe("tok-2");
    expect(listAccounts()).toHaveLength(1);
    expect(listAccounts()[0].cloudUserId).toBe("u2");
  });

  it("removeAccount 活跃账号：自动选择剩余账号为新活跃", () => {
    addAccount("u1", "tok-1");
    addAccount("u2", "tok-2");
    // u2 是活跃，删除 u2 → u1 应成为新活跃
    removeAccount("u2");

    expect(listAccounts()).toHaveLength(1);
    expect(getActiveAccountId()).toBe("u1");
    expect(getAccessToken()).toBe("tok-1");
  });

  it("removeAccount 最后一个账号：清空 activeId 并删除 TOKEN_KEY", () => {
    addAccount("u1", "tok-1");
    removeAccount("u1");

    expect(getActiveAccountId()).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(listAccounts()).toHaveLength(0);
  });

  it("clearAccessToken 同时清空账号 store（全量登出）", () => {
    addAccount("u1", "tok-1");
    addAccount("u2", "tok-2");
    clearAccessToken();

    expect(getAccessToken()).toBeNull();
    expect(getActiveAccountId()).toBeNull();
    expect(listAccounts()).toHaveLength(0);
  });

  it("malformed JSON in ACCOUNTS_KEY 被容错处理，视为空 store", () => {
    localStorage.setItem("meshbot_accounts", "{not valid json{{");
    // 不应抛出
    expect(listAccounts()).toEqual([]);
    expect(getActiveAccountId()).toBeNull();
    // addAccount 仍正常工作
    addAccount("u1", "tok-1");
    expect(listAccounts()).toHaveLength(1);
  });

  it("getAccessToken 返回活跃 token", () => {
    addAccount("u1", "tok-1");
    expect(getAccessToken()).toBe("tok-1");
    addAccount("u2", "tok-2");
    expect(getAccessToken()).toBe("tok-2");
    setActiveAccount("u1");
    expect(getAccessToken()).toBe("tok-1");
  });
});
