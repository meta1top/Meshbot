import { describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service";
import type { ActiveModelConfig } from "../../src/config/model-config.reader";
import { CLOUD_GATEWAY_API_KEY_PLACEHOLDER } from "../../src/config/model-config.reader";
import type { CloudTokenPort } from "../../src/graph/cloud-token.port";
import type { ModelConfigReadPort } from "../../src/graph/model-config-read.port";
import { ModelResolver } from "../../src/graph/model-resolver.service";
import { ModelRunContext } from "../../src/graph/model-run-context";

/**
 * 验证 Task 9 的接线：ModelResolver 经 CLOUD_TOKEN_PORT 取当前账号 device
 * token，通过 createChatModel 的 cloudTokenProvider 落到实际请求的
 * Authorization header 上——覆盖「按当前账号解析」「轮换透明（缓存命中仍取最
 * 新值）」「多账号隔离（共享同一 chat model 缓存实例时互不串号）」三个不变量。
 *
 * Critical C-1 修复后：模型配置改经 MODEL_CONFIG_READ_PORT 解析（不再直读
 * sqlite），这里用按账号建模的 fake port 提供 resolveActive()。
 */
describe("ModelResolver 云网关 device token 接线", () => {
  const GATEWAY_CFG: ActiveModelConfig = {
    providerType: "openai-compatible",
    model: "gw-model",
    name: "网关",
    apiKey: CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
    baseUrl: "http://gw.test/api/v1",
    isCloudModel: true,
  };
  const LOCAL_CFG: ActiveModelConfig = {
    providerType: "openai",
    model: "local-model",
    name: "本地",
    apiKey: "sk-real",
    baseUrl: "",
    isCloudModel: false,
  };

  function makeModelConfigPort(
    account: AccountContextService,
    activeByAcct: Record<string, ActiveModelConfig>,
  ): ModelConfigReadPort {
    return {
      async resolveActive() {
        const acct = account.get();
        return acct ? (activeByAcct[acct] ?? null) : null;
      },
      async resolveById() {
        return null;
      },
    };
  }

  function make(
    cloudPort: CloudTokenPort,
    activeByAcct: Record<string, ActiveModelConfig>,
  ) {
    const account = new AccountContextService();
    const runCtx = new ModelRunContext();
    const modelConfigPort = makeModelConfigPort(account, activeByAcct);
    const resolver = new ModelResolver(
      account,
      runCtx,
      modelConfigPort,
      undefined,
      undefined,
      cloudPort,
    );
    return { account, runCtx, resolver };
  }

  /** 假 fetch：返回一条固定的 chat.completion 响应，把每次请求的 Authorization 记进数组。 */
  function stubFetch(captured: (string | null)[]): typeof fetch {
    return (async (_input: unknown, init?: RequestInit) => {
      const headers = init?.headers;
      const auth =
        headers instanceof Headers
          ? headers.get("Authorization")
          : ((headers as Record<string, string> | undefined)?.Authorization ??
            null);
      captured.push(auth);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "gw-model",
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
  }

  it("按当前账号（AccountContextService）解析 device token 并注入请求", async () => {
    const port: CloudTokenPort = { resolve: async () => "token-u1" };
    const { account, runCtx, resolver } = make(port, { u1: GATEWAY_CFG });
    const captured: (string | null)[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(captured);
    try {
      await account.run("u1", () =>
        runCtx.run(null, async () => {
          // 用 getTitleModel（streaming:false）走 invoke：与 resolveModel 共用同一套
          // cloudTokenProvider / refreshCloudToken / cloudTokenByAccount 接线，
          // 避免为验证 header 而搭建 SSE 流式响应 stub。
          const model = await resolver.getTitleModel();
          await model.invoke("hi");
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(captured).toEqual(["Bearer token-u1"]);
  });

  it("token 轮换：chat model 缓存命中时仍取最新 token（不烘死在构造时）", async () => {
    let currentToken = "token-old";
    const port: CloudTokenPort = { resolve: async () => currentToken };
    const { account, runCtx, resolver } = make(port, { u1: GATEWAY_CFG });
    const captured: (string | null)[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(captured);
    try {
      await account.run("u1", () =>
        runCtx.run(null, async () => {
          // 用 getTitleModel（streaming:false）走 invoke：与 resolveModel 共用同一套
          // cloudTokenProvider / refreshCloudToken / cloudTokenByAccount 接线，
          // 避免为验证 header 而搭建 SSE 流式响应 stub。
          const model = await resolver.getTitleModel();
          await model.invoke("hi");
        }),
      );
      currentToken = "token-new";
      await account.run("u1", () =>
        runCtx.run(null, async () => {
          const model = await resolver.getTitleModel(); // 命中 chat model 缓存
          await model.invoke("hi");
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(captured).toEqual(["Bearer token-old", "Bearer token-new"]);
  });

  it("多账号隔离：共享同一 chat model 缓存实例时，各自请求仍带自己账号的 token", async () => {
    const tokenByAccount: Record<string, string> = {
      u1: "token-u1",
      u2: "token-u2",
    };
    // account 在下面 make() 的解构里才赋值，但 resolve() 是异步回调、真正执行
    // 时 account 早已初始化——闭包捕获的是绑定而非当时的值，同 CLOUD_TOKEN_PORT
    // 原实现的写法。
    const port: CloudTokenPort = {
      resolve: async () => tokenByAccount[account.get() ?? ""] ?? null,
    };
    const { account, runCtx, resolver } = make(port, {
      u1: GATEWAY_CFG,
      u2: GATEWAY_CFG,
    });
    const captured: (string | null)[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(captured);
    try {
      // u1 先建 chat model 缓存
      await account.run("u1", () =>
        runCtx.run(null, async () => {
          // 用 getTitleModel（streaming:false）走 invoke：与 resolveModel 共用同一套
          // cloudTokenProvider / refreshCloudToken / cloudTokenByAccount 接线，
          // 避免为验证 header 而搭建 SSE 流式响应 stub。
          const model = await resolver.getTitleModel();
          await model.invoke("hi");
        }),
      );
      // u2 复用同一缓存实例（配置完全同形），仍应带 u2 自己的 token
      await account.run("u2", () =>
        runCtx.run(null, async () => {
          // 用 getTitleModel（streaming:false）走 invoke：与 resolveModel 共用同一套
          // cloudTokenProvider / refreshCloudToken / cloudTokenByAccount 接线，
          // 避免为验证 header 而搭建 SSE 流式响应 stub。
          const model = await resolver.getTitleModel();
          await model.invoke("hi");
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(captured).toEqual(["Bearer token-u1", "Bearer token-u2"]);
  });

  it("非云模型：不调用 CLOUD_TOKEN_PORT（本地/ollama 直连不受影响）", async () => {
    let resolveCalls = 0;
    const port: CloudTokenPort = {
      resolve: async () => {
        resolveCalls += 1;
        return "should-not-be-used";
      },
    };
    const { account, runCtx, resolver } = make(port, { u3: LOCAL_CFG });
    await account.run("u3", () =>
      runCtx.run(null, () => resolver.resolveModel()),
    );
    expect(resolveCalls).toBe(0);
  });
});
