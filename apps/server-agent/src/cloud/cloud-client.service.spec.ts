import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudClientService } from "./cloud-client.service";

/** 用注入的 fetch 桩验证：信封解包、错误码透传、不可达映射、401 处理。 */
function makeClient(fetchImpl: typeof fetch): CloudClientService {
  return new CloudClientService("http://cloud.test", fetchImpl);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CloudClientService", () => {
  it("成功信封返回 data", async () => {
    const client = makeClient((async () =>
      jsonResponse({
        success: true,
        code: 0,
        data: { token: "t" },
      })) as unknown as typeof fetch);
    const data = await client.post<{ token: string }>("/api/auth/login", {
      email: "a",
    });
    expect(data).toEqual({ token: "t" });
  });

  it("业务错误信封透传云端 code/message 为 AppError", async () => {
    const client = makeClient((async () =>
      jsonResponse({
        success: false,
        code: 2002,
        message: "邮箱或密码错误",
      })) as unknown as typeof fetch);
    await expect(client.post("/api/auth/login", {})).rejects.toMatchObject({
      name: "AppError",
      errorCode: expect.objectContaining({ code: 2002 }),
    });
  });

  it("网络异常映射 CLOUD_UNREACHABLE", async () => {
    const client = makeClient((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(client.post("/api/auth/login", {})).rejects.toMatchObject({
      errorCode: AgentErrorCode.CLOUD_UNREACHABLE,
    });
  });

  it("云端 401 触发 unauthorized 处理器并抛 AUTH_UNAUTHORIZED", async () => {
    const client = makeClient((async () =>
      jsonResponse(
        { success: false, code: 3003 },
        401,
      )) as unknown as typeof fetch);
    const onUnauthorized = jest.fn();
    client.setUnauthorizedHandler(onUnauthorized);
    await expect(client.get("/api/orgs", "stale-token")).rejects.toMatchObject({
      errorCode: AgentErrorCode.AUTH_UNAUTHORIZED,
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("请求带 token 时附加 Authorization 头", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ success: true, code: 0, data: [] }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.get("/api/orgs", "my-token");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://cloud.test/api/orgs");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer my-token",
    );
  });
});

describe("CloudClientService 401 处理器异常", () => {
  it("处理器抛错不掩盖 AUTH_UNAUTHORIZED", async () => {
    const client = makeClient((async () =>
      jsonResponse(
        { success: false, code: 3003 },
        401,
      )) as unknown as typeof fetch);
    client.setUnauthorizedHandler(() => {
      throw new Error("db write failed");
    });
    await expect(client.get("/api/orgs", "stale")).rejects.toMatchObject({
      errorCode: AgentErrorCode.AUTH_UNAUTHORIZED,
    });
  });
});
