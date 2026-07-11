import { buildCloudFetch, createChatModel } from "./llm.factory";

describe("buildCloudFetch", () => {
  it("云模型：fetch 包装用动态 token 覆盖 Authorization", async () => {
    let seen = "";
    const fakeFetch = async (_u: unknown, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).Authorization;
      return new Response("{}");
    };
    const wrapped = buildCloudFetch(
      fakeFetch as typeof fetch,
      () => "mbd_LIVE",
    );
    await wrapped("http://gw/api/v1/chat/completions", {
      headers: { Authorization: "Bearer __cloud__" },
      method: "POST",
      body: "{}",
    });
    expect(seen).toBe("Bearer mbd_LIVE");
  });

  it("token 轮换：同一个 wrapped fetch 后续调用取最新 token（不烘死在闭包里）", async () => {
    let seen = "";
    let currentToken = "mbd_old";
    const fakeFetch = async (_u: unknown, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).Authorization;
      return new Response("{}");
    };
    const wrapped = buildCloudFetch(
      fakeFetch as typeof fetch,
      () => currentToken,
    );

    await wrapped("http://gw/api/v1/chat/completions", { headers: {} });
    expect(seen).toBe("Bearer mbd_old");

    currentToken = "mbd_new";
    await wrapped("http://gw/api/v1/chat/completions", { headers: {} });
    expect(seen).toBe("Bearer mbd_new");
  });

  it("tokenProvider 返回 null：Authorization 退化为空 Bearer（不抛错）", async () => {
    let seen = "";
    const fakeFetch = async (_u: unknown, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).Authorization;
      return new Response("{}");
    };
    const wrapped = buildCloudFetch(fakeFetch as typeof fetch, () => null);
    await wrapped("http://gw/api/v1/chat/completions", { headers: {} });
    expect(seen).toBe("Bearer ");
  });

  it("保留原有的其他 header（普通 record 形状），只覆盖 Authorization", async () => {
    let seenHeaders: Record<string, string> = {};
    const fakeFetch = async (_u: unknown, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      return new Response("{}");
    };
    const wrapped = buildCloudFetch(
      fakeFetch as typeof fetch,
      () => "mbd_LIVE",
    );
    await wrapped("http://gw/api/v1/chat/completions", {
      headers: {
        Authorization: "Bearer __cloud__",
        "Content-Type": "application/json",
      },
    });
    expect(seenHeaders.Authorization).toBe("Bearer mbd_LIVE");
    expect(seenHeaders["Content-Type"]).toBe("application/json");
  });

  it("原生 Headers 实例：clone 后覆盖 Authorization，其余 header 不丢失", async () => {
    let seenHeaders: Headers | undefined;
    const fakeFetch = async (_u: unknown, init: RequestInit) => {
      seenHeaders = init.headers as Headers;
      return new Response("{}");
    };
    const wrapped = buildCloudFetch(
      fakeFetch as typeof fetch,
      () => "mbd_LIVE",
    );
    const originalHeaders = new Headers({
      Authorization: "Bearer __cloud__",
      "User-Agent": "openai-node",
    });
    await wrapped("http://gw/api/v1/chat/completions", {
      headers: originalHeaders,
    });

    expect(seenHeaders).toBeInstanceOf(Headers);
    expect(seenHeaders?.get("Authorization")).toBe("Bearer mbd_LIVE");
    expect(seenHeaders?.get("User-Agent")).toBe("openai-node");
    // 不得就地篡改调用方传入的原始 Headers 引用
    expect(originalHeaders.get("Authorization")).toBe("Bearer __cloud__");
  });
});

describe("createChatModel：云模型分支", () => {
  it("isCloudModel=true 时用占位 apiKey 建 client，且请求经 buildCloudFetch 动态换 token", async () => {
    let capturedAuth: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const headers = init?.headers;
      capturedAuth =
        headers instanceof Headers
          ? headers.get("Authorization")
          : ((headers as Record<string, string> | undefined)?.Authorization ??
            null);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const model = await createChatModel(
        {
          providerType: "openai-compatible",
          model: "gpt-4o",
          apiKey: "__cloud__",
          baseUrl: "http://gw.test/api/v1",
          isCloudModel: true,
        },
        { streaming: false, cloudTokenProvider: () => "mbd_LIVE" },
      );
      await model.invoke("hi");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedAuth).toBe("Bearer mbd_LIVE");
  });
});

describe("createChatModel：本地轨 provider 白名单", () => {
  // 本地轨只经云网关取模型：model-config-sync.service.ts 的 toGatewayRow 把下发行
  // 的 providerType 固定写成 openai-compatible，真实厂商调用发生在 server-main 的
  // model-gateway。所以本地轨出现其他 providerType 一定是脏数据。
  //
  // 守卫必须显式抛错：hoisted 模式下 @langchain/anthropic 仍物理存在于根
  // node_modules（server-main 依赖它），不加守卫的话 initChatModel 会静默成功，
  // 用一条本地直连打到厂商——这正是我们要杜绝的。
  it("未知 providerType（anthropic）→ 抛错，而不是静默走 hoisted 的厂商包", async () => {
    await expect(
      createChatModel({
        providerType: "anthropic",
        model: "claude-sonnet-4-5",
        apiKey: "sk-ant-fake",
        baseUrl: "",
        isCloudModel: false,
      }),
    ).rejects.toThrow(/本地轨不支持的 providerType：anthropic/);
  });

  it("deepseek 同样被拒（真实厂商调用应发生在云网关侧）", async () => {
    await expect(
      createChatModel({
        providerType: "deepseek",
        model: "deepseek-chat",
        apiKey: "sk-fake",
        baseUrl: "",
        isCloudModel: false,
      }),
    ).rejects.toThrow(/本地轨不支持的 providerType：deepseek/);
  });

  it("openai 与 openai-compatible 仍在白名单内", async () => {
    await expect(
      createChatModel({
        providerType: "openai",
        model: "gpt-4o",
        apiKey: "sk-fake",
        baseUrl: "",
        isCloudModel: false,
      }),
    ).resolves.toBeDefined();

    await expect(
      createChatModel({
        providerType: "openai-compatible",
        model: "deepseek-chat",
        apiKey: "sk-fake",
        baseUrl: "https://api.deepseek.com/v1",
        isCloudModel: false,
      }),
    ).resolves.toBeDefined();
  });
});
