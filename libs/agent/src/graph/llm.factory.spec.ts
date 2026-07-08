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
