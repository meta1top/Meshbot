# DeepSeek 接入云模型网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让云端 DeepSeek 组织模型经 server-main 网关端到端可用（去掉网关对 deepseek 的未完成拒绝），厂商处理全在网关内部，agent 保持纯 openai 兼容。

**Architecture:** 网关 `ModelGatewayService.build()` 去掉 `providerType==="deepseek"` 硬拒，正常经 `initChatModel` 用 `@langchain/deepseek` 构造；DeepSeek thinking 多轮校验所需的 `reasoning_content` 空串注入，用一个网关侧自包含的 fetch 包装完成；思考链走 A（出站零改动，`openai-adapter` 本就只吐 content/tool_calls，reasoning 自然不外露）。

**Tech Stack:** NestJS (server-main) + langchain `initChatModel` (universal) + `@langchain/deepseek@0.1.0` + Jest（根配置，ts-jest，node env）。

## Global Constraints

- **改动全在 server-main**；**不改** server-agent / libs/agent / 下发逻辑（`ModelConfigSyncService`）/ `openai-adapter.ts`。
- 思考链走 **A：不外露**——出站零改动。
- 依赖 `@langchain/deepseek@0.1.0`（与 libs/agent 对齐的版本）。
- **跨轨不 import libs/agent**：`deepseekReasoningFetch` 在网关侧自包含实现（不复用 llm.factory 的私有函数）。
- 纯逻辑 / 单测走**根 jest**，spec 是 `.ts`，**相对 import**。全量 `pnpm test` 有既有无关失败（vitest 文件被根 jest 误拾），只跑**针对性** `jest <path>`。
- 单测里 `initChatModel` 被 `jest.mock` 打桩，**不真正加载** `@langchain/deepseek`——依赖能否动态加载靠**端到端眼验**确认（Task 2 Step 8）。
- 中文 conventional commit，结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 所有命令在 worktree 根 `/Users/grant/Meta1/meshbot/.claude/worktrees/gateway-deepseek` 下执行，分支 `worktree-gateway-deepseek`。

## 文件结构

- **Create** `apps/server-main/src/model-gateway/deepseek-fetch.ts` — `deepseekReasoningFetch(base)`：拦 POST body 给缺字段的 assistant 消息补 `reasoning_content:""`。自包含、零依赖。
- **Create** `apps/server-main/src/model-gateway/deepseek-fetch.spec.ts` — 上者单测。
- **Modify** `apps/server-main/package.json` — 加 `@langchain/deepseek@0.1.0`。
- **Modify** `apps/server-main/src/model-gateway/model-gateway.service.ts` — 去 deepseek 拒绝、deepseek 分支挂 fetch、import helper、订正注释。
- **Modify** `apps/server-main/src/model-gateway/model-gateway.service.spec.ts` — 把"deepseek → 抛错"用例改为"deepseek → 正常构建"。

---

### Task 1: `deepseekReasoningFetch` fetch 包装 + 单测

**Files:**
- Create: `apps/server-main/src/model-gateway/deepseek-fetch.ts`
- Test: `apps/server-main/src/model-gateway/deepseek-fetch.spec.ts`

**Interfaces:**
- Produces: `deepseekReasoningFetch(base: typeof fetch): typeof fetch` — 供 Task 2 的 `ModelGatewayService.build()` 在 deepseek 分支设 `configuration.fetch`。

- [ ] **Step 1: 先写失败单测 `deepseek-fetch.spec.ts`**（相对 import）

```ts
import { deepseekReasoningFetch } from "./deepseek-fetch";

/** base fetch 打桩：不关心返回，只断言被调用时的入参。 */
function makeBase() {
  return jest.fn(async () => ({}) as unknown as Response);
}

describe("deepseekReasoningFetch", () => {
  it("给缺 reasoning_content 的 assistant 消息注入空串", async () => {
    const base = makeBase();
    const f = deepseekReasoningFetch(base as unknown as typeof fetch);
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
      ],
    });
    await f("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body,
    });
    const sent = JSON.parse(
      (base.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.messages[1].reasoning_content).toBe("");
    expect(sent.messages[0].reasoning_content).toBeUndefined();
  });

  it("assistant 已带 reasoning_content → 不改、原样透传（同一 body 引用）", async () => {
    const base = makeBase();
    const f = deepseekReasoningFetch(base as unknown as typeof fetch);
    const body = JSON.stringify({
      messages: [{ role: "assistant", content: "x", reasoning_content: "keep" }],
    });
    await f("u", { method: "POST", body });
    expect((base.mock.calls[0][1] as RequestInit).body).toBe(body);
  });

  it("无 body → 透传", async () => {
    const base = makeBase();
    const f = deepseekReasoningFetch(base as unknown as typeof fetch);
    await f("u", {});
    expect(base).toHaveBeenCalledWith("u", {});
  });

  it("body 非 JSON → 透传不抛", async () => {
    const base = makeBase();
    const f = deepseekReasoningFetch(base as unknown as typeof fetch);
    await f("u", { body: "not json" });
    expect(base).toHaveBeenCalledWith("u", { body: "not json" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec jest apps/server-main/src/model-gateway/deepseek-fetch.spec.ts`
Expected: FAIL — `Cannot find module './deepseek-fetch'`。

- [ ] **Step 3: 实现 `deepseek-fetch.ts`**

```ts
/**
 * fetch 包装：拦 POST /chat/completions 的 JSON body，给 role=assistant 且
 * 缺 reasoning_content 的消息补空 reasoning_content —— DeepSeek thinking 模式
 * 要求历史 assistant 消息带该字段，否则多轮请求被服务端校验拒。
 *
 * 移植自 libs/agent 的 patchedFetchForDeepseek；跨轨不 import，网关侧自包含。
 */
export function deepseekReasoningFetch(base: typeof fetch): typeof fetch {
  return async function patched(input, init) {
    if (!init?.body || typeof init.body !== "string") {
      return base(input, init);
    }
    let body: { messages?: Array<Record<string, unknown>> };
    try {
      body = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }
    if (!Array.isArray(body.messages)) {
      return base(input, init);
    }
    let patched = false;
    for (const msg of body.messages) {
      if (msg.role === "assistant" && msg.reasoning_content === undefined) {
        msg.reasoning_content = "";
        patched = true;
      }
    }
    if (!patched) {
      return base(input, init);
    }
    return base(input, { ...init, body: JSON.stringify(body) });
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec jest apps/server-main/src/model-gateway/deepseek-fetch.spec.ts`
Expected: PASS（4/4）。

- [ ] **Step 5: 提交**

```bash
git add apps/server-main/src/model-gateway/deepseek-fetch.ts \
        apps/server-main/src/model-gateway/deepseek-fetch.spec.ts
git commit -m "feat(gateway): deepseekReasoningFetch —— assistant 消息补 reasoning_content 空串 + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 网关接入 DeepSeek（去拒绝 + 挂 fetch + 加依赖 + 改测）

**Files:**
- Modify: `apps/server-main/package.json`（加依赖）
- Modify: `apps/server-main/src/model-gateway/model-gateway.service.ts`
- Modify: `apps/server-main/src/model-gateway/model-gateway.service.spec.ts`（改 deepseek 用例）

**Interfaces:**
- Consumes: Task 1 的 `deepseekReasoningFetch`（`import { deepseekReasoningFetch } from "./deepseek-fetch"`）。
- 行为变化：`ModelGatewayService.complete/stream` 对 `providerType==="deepseek"` 不再抛 `GatewayModelNotFoundError`，而是正常经 `initChatModel(model, { modelProvider:"deepseek", apiKey, configuration:{ ..., fetch } })` 构造并调用。

- [ ] **Step 1: 加依赖 `@langchain/deepseek@0.1.0`**

Run: `pnpm --filter @meshbot/server-main add @langchain/deepseek@0.1.0`
Expected: `apps/server-main/package.json` 的 `dependencies` 出现 `"@langchain/deepseek": "0.1.0"`，pnpm-lock 更新，install 成功。
（说明：单测 mock 了 `initChatModel` 不会真加载该包；此依赖为运行时动态加载所需，靠 Step 8 眼验确认。）

- [ ] **Step 2: 改现有 deepseek 单测为"正常构建"（TDD 先失败）**

在 `apps/server-main/src/model-gateway/model-gateway.service.spec.ts` 中，把现有用例（约 :59-76）:

```ts
  it("deepseek 模型 → 抛 GatewayModelNotFoundError（v1 不经网关，端侧直连）", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "deepseek",
      model: "deepseek-chat",
      baseUrl: null,
      apiKey: "sk-x",
      contextWindow: 64000,
    });

    await expect(
      service.complete(
        "o1",
        { model: "m-deepseek", messages: [{ role: "user", content: "hi" }] },
        "cmpl-2",
      ),
    ).rejects.toBeInstanceOf(GatewayModelNotFoundError);
    expect(initChatModel).not.toHaveBeenCalled();
  });
```

整段替换为:

```ts
  it("deepseek 模型 → 正常构建并调 provider（不再拒绝）", async () => {
    orgSvc.resolveDecrypted.mockResolvedValue({
      providerType: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-x",
      contextWindow: 64000,
    });

    const out: any = await service.complete(
      "o1",
      { model: "m-deepseek", messages: [{ role: "user", content: "hi" }] },
      "cmpl-2",
    );

    expect(out.choices[0].message.content).toBe("hi from provider");
    // 用真实模型名 deepseek-chat + deepseek provider + 注入 reasoning 的 fetch
    expect(initChatModel).toHaveBeenCalledWith(
      "deepseek-chat",
      expect.objectContaining({
        modelProvider: "deepseek",
        apiKey: "sk-x",
        configuration: expect.objectContaining({ fetch: expect.any(Function) }),
      }),
    );
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec jest apps/server-main/src/model-gateway/model-gateway.service.spec.ts`
Expected: FAIL —— 新用例失败（现实现仍对 deepseek 抛 `GatewayModelNotFoundError`，`complete` reject 而非返回 completion）。其余用例仍绿。

- [ ] **Step 4: 改 `model-gateway.service.ts` —— 去拒绝 + deepseek 挂 fetch**

顶部加 import（与其他相对 import 并列）:

```ts
import { deepseekReasoningFetch } from "./deepseek-fetch";
```

把 `build()` 里这段:

```ts
    if (!resolved) throw new GatewayModelNotFoundError(req.model);
    // DeepSeek v1 不经网关，仍端侧直连——网关侧一律当作"模型不存在"拒绝。
    if (resolved.providerType === "deepseek") {
      throw new GatewayModelNotFoundError(req.model);
    }
    const configuration: Record<string, unknown> = {};
    if (resolved.baseUrl) configuration.baseURL = resolved.baseUrl;
```

改为:

```ts
    if (!resolved) throw new GatewayModelNotFoundError(req.model);
    const configuration: Record<string, unknown> = {};
    if (resolved.baseUrl) configuration.baseURL = resolved.baseUrl;
    // DeepSeek thinking 模式要求历史 assistant 消息带 reasoning_content，
    // @langchain/openai 序列化时不回写——拦 fetch 补空字段（详见 deepseek-fetch.ts）。
    if (resolved.providerType === "deepseek") {
      configuration.fetch = deepseekReasoningFetch(globalThis.fetch);
    }
```

（`modelProvider` 用现有 `PROVIDER_MODEL_NAME[resolved.providerType] ?? resolved.providerType` 即可得到 `"deepseek"`，**无需**给 `PROVIDER_MODEL_NAME` 加自映射项。）

再把类顶部 `GatewayModelNotFoundError` 的注释:

```ts
/** 网关内部：按 orgId+modelId 找不到归属模型（含 deepseek v1 不经网关）时抛出，Controller 映射 404/403。 */
```

订正为:

```ts
/** 网关内部：按 orgId+modelId 找不到归属模型时抛出，Controller 映射 404/403。 */
```

- [ ] **Step 5: 跑网关全部单测确认通过**

Run: `pnpm exec jest apps/server-main/src/model-gateway/`
Expected: PASS（deepseek-fetch + model-gateway.service + chat-completions.controller 全绿；deepseek 新用例通过，其余不受影响）。

- [ ] **Step 6: typecheck**

Run: `pnpm --filter @meshbot/server-main typecheck`
Expected: exit 0，无报错。

- [ ] **Step 7: 提交**

```bash
git add apps/server-main/package.json \
        apps/server-main/src/model-gateway/model-gateway.service.ts \
        apps/server-main/src/model-gateway/model-gateway.service.spec.ts \
        pnpm-lock.yaml
git commit -m "feat(gateway): 接入 DeepSeek —— 去掉未完成拒绝、deepseek 挂 reasoning fetch、加 @langchain/deepseek

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: 运行时动态加载确认 + 端到端眼验**

先做**无需真 key** 的动态加载确认（构造 client 不发网络，只 invoke/stream 才发）:

Run:
```bash
pnpm --filter @meshbot/server-main exec tsx -e "import('langchain/chat_models/universal').then(async ({initChatModel})=>{const m=await initChatModel('deepseek-chat',{modelProvider:'deepseek',apiKey:'x'});console.log('OK', m?.constructor?.name)})"
```
Expected: 打印 `OK ChatDeepSeek`（或类似 deepseek 模型类名）——证明 `@langchain/deepseek` 能被 `initChatModel` 动态加载、provider 名 `deepseek` 正确。若报 `Unable to import @langchain/deepseek` → 依赖没装好，回 Step 1。

再做**端到端眼验**（需 server-main 起 + 一个配了**真实 DeepSeek key** 的组织）:
- 云端建 DeepSeek 组织模型（provider=deepseek，真实 key）→ 本地 agent 起一个 run。
- Expected: 不再 `404 model not found`；能正常出话（多轮 / 工具调用亦可）。思考链不显示（方案 A，符合预期）。

---

## 自检（对照 spec）

- **spec 覆盖:**
  - 「去掉 deepseek 拒绝」→ Task 2 Step 4 删三行。✅
  - 「deepseek 挂 reasoning fetch（移植 patchedFetchForDeepseek，网关侧自包含）」→ Task 1（helper + 单测）+ Task 2 Step 4（挂载）。✅
  - 「加依赖 @langchain/deepseek@0.1.0」→ Task 2 Step 1。✅
  - 「出站零改动（A）」→ 未触及 openai-adapter.ts（改动清单无它）。✅
  - 「改现有 deepseek 拒绝用例」→ Task 2 Step 2。✅
  - 「agent / 下发 / 本地直连 不动」→ 改动清单仅 server-main model-gateway。✅
- **placeholder 扫描:** 无 TBD/TODO；每个改码步骤含完整代码或精确命令。✅
- **类型一致性:** `deepseekReasoningFetch(base: typeof fetch): typeof fetch` 在 Task 1 定义、Task 2 Step 4 按此签名 `deepseekReasoningFetch(globalThis.fetch)` 调用，一致。✅
- **spec 微调说明:** spec 的改动项列了「`PROVIDER_MODEL_NAME` 加 `deepseek: "deepseek"`」；实现时发现该项与现有 `?? resolved.providerType` 回退**冗余**（回退已产出 `"deepseek"`），故 Task 2 略去、避免无意义自映射。单测断言 `modelProvider:"deepseek"` 仍成立。
- **测试局限已标注:** 单测 mock `initChatModel`，不覆盖真实依赖加载 → Task 2 Step 8 用 tsx 动态加载确认 + 眼验补齐。✅
