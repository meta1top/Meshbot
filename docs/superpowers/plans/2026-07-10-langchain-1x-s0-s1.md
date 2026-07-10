# langchain 1.x 迁移 S0 + S1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把全仓 langchain 生态从 0.3/0.6 原子升级到 1.x，且运行时行为逐字节不变，为后续「显示 DeepSeek 思考链」铺路。

**Architecture:** 依赖升级必须原子（peer 图 + `nodeLinker: hoisted` 单副本，不存在可编译的中间态）。因此先把**与版本无关**的 libs/agent 瘦身和冒烟测在 0.x 基线上做完并跑绿，再一次性抬版本、只修编译破坏。每个 commit 都必须 typecheck 绿 + 测试绿，保证可 bisect。

**Tech Stack:** TypeScript / NestJS / LangChain 1.x / LangGraph 1.x / better-sqlite3 / jest（server-*、libs/common）/ vitest（libs/agent）/ pnpm workspace（hoisted）

## Global Constraints

- 分支 `feat/langchain-1x`，worktree `/Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x`，基线 `main@7c235e1d`。**单分支连续提交，不切 PR**，直到用户明确指示合并。
- **S1 行为零变化**：reasoning 仍读 `additional_kwargs.reasoning_content`，不引入任何 `contentBlocks` 读取。
- **`@langchain/openai` 必须精确钉 `1.5.5`**（不带 `^`）。`@langchain/deepseek@1.1.5` 的 dependencies 是 `"@langchain/openai": "1.5.5"` 精确版本；写 `^1.5.5` 会在上游发 1.5.6 时让树里出现两份 openai。
- 目标版本（已用 `npm view` 核实互相兼容）：`@langchain/core@^1.2.2`、`@langchain/langgraph@^1.4.7`、`@langchain/langgraph-checkpoint@^1.1.3`、`@langchain/langgraph-checkpoint-sqlite@^1.0.3`、`langchain@^1.5.3`、`@langchain/anthropic@1.5.1`、`@langchain/deepseek@1.1.5`、`@langchain/google-genai@2.2.0`、`@langchain/ollama@1.3.0`。`@langchain/mcp-adapters` 保持 `^1.1.3` 不动。
- **不动 zod**（仓库 `3.25.76` 已满足 langgraph 1.x 的 `^3.25.32 || ^4.2.0`）、不动 `nestjs-zod`。
- **不动** `libs/types-agent/src/ai/providers.ts` 的 `PROVIDERS` 常量与 `apps/web-main` 的模型表单——那张表驱动的是**云端** `OrgModelConfig`，server-main 的 model-gateway 靠它选真实厂商。
- `pnpm check` 是 **9 个**围栏：`tx / naming / lock-tx / repo / scope / dead / error-code / pk / dev-script`。
- 静态围栏与格式化：每次改完代码跑 `pnpm check:format`（Biome）。
- **hoisted 陷阱**：从 `libs/agent/package.json` 删掉一个 provider 包，**不会**让 `import("@langchain/deepseek")` 失败——`apps/server-main` 仍依赖它，hoisted 把它提到根 `node_modules` 共享。真正的强制手段是 Task 2 的白名单守卫抛错。

---

## File Structure

| 文件 | 职责 | 本计划中的动作 |
|---|---|---|
| `libs/agent/package.json` | 本地轨依赖声明 | 升 6 个包，删 4 个 provider 包 |
| `apps/server-agent/package.json` | 本地轨后端依赖 | 升 `@langchain/core` |
| `apps/server-main/package.json` | 云端网关依赖 | 升 core + langchain + 全部 5 个 provider（**全保留**） |
| `pnpm-workspace.yaml` | overrides | `@langchain/langgraph-checkpoint` → `^1.1.3` |
| `libs/agent/src/graph/llm.factory.ts` | 本地轨模型工厂 | 收敛 provider 白名单 + 加守卫抛错 + 删 `patchedFetchForDeepseek` + 删 `modelKwargs` 选项 |
| `libs/agent/src/graph/llm.factory.spec.ts` | 云 fetch 契约 + 白名单守卫 | 新增守卫用例（已有的云 fetch 端到端用例必须保持绿） |
| `libs/agent/src/graph/model-resolver.service.ts` | 模型解析/缓存 | 删 deepseek thinking-disable 分支 |
| `libs/agent/tests/unit/model-resolver-override.test.ts` | 覆盖解析 | fixture `deepseek` → `openai-compatible` |
| `apps/server-main/src/model-gateway/provider-smoke.spec.ts` | **新建**：5 provider 构建期冒烟 | 补 typecheck 盲区 |
| `docs/superpowers/specs/2026-07-10-langchain-1x-s0-s1-design.md` | 设计 spec | 修 3 处事实错误 |

---

## Task 0: S0 准备、spec 勘误与基线固定

**Files:**
- Modify: `docs/superpowers/specs/2026-07-10-langchain-1x-s0-s1-design.md`
- 无源码改动。产出「基线记录」到 scratchpad。

**Interfaces:**
- Consumes: 无
- Produces: `<scratchpad>/baseline.md` —— 后续 Task 判断「是否回归」的唯一参照。含三项：`pnpm typecheck` 结果、targeted jest 结果、`libs/agent` vitest 的**失败用例名清单**。

**背景（实施者必读）：** worktree 里有自己的 `pnpm-workspace.yaml`，而 `libs/agent/src/config/meshbot-config.service.ts:7-19` 的 `findRepoRoot` 正是靠找 `pnpm-workspace.yaml` 定位仓库根。所以从 worktree 跑 dev 会用**worktree 内部一个全新的空 `.meshbot`**，而不是主仓那份已授权的。端到端眼验必须显式设 `MESHBOT_HOME` 指向主仓那份。要清 checkpoint 的，也正是主仓那份。

- [ ] **Step 1: 修正 spec 的三处事实错误**

我在写 spec 时有三处与代码不符，先改掉，免得后续 Task 照着错的做。

1. 第 5.2.2 节的表名 `model_config` → `model_configs`（`apps/server-agent/src/entities/model-config.entity.ts:4` 是 `@Entity("model_configs")`）。
2. 第 7 节的「`pnpm check` 六个静态围栏」→ 九个（`tx/naming/lock-tx/repo/scope/dead/error-code/pk/dev-script`）。
3. 第 4.1 节要补一句：清库目标是 `MESHBOT_HOME` 指向的那份 `.meshbot`（主仓 `/Users/grant/Meta1/meshbot/.meshbot`），不是 worktree 内自动新建的那份。

对应编辑：

`5.2.2` 节的 SQL 改成：

```sql
SELECT id, provider_type, source FROM model_configs
WHERE source = 'local' AND provider_type NOT IN ('openai', 'openai-compatible');
```

`4.1` 节标题下第一句改成：

```markdown
对 `$MESHBOT_HOME/accounts/*/agent.db`（dev 默认 `/Users/grant/Meta1/meshbot/.meshbot`，
**不是** worktree 内自动新建的那份）执行：
```

`7` 节的围栏行改成：

```markdown
- `pnpm check` 九个静态围栏绿（tx / naming / lock-tx / repo / scope / dead / error-code / pk / dev-script）
```

- [x] **Step 2: 盘点（已执行，实测推翻「同库」假设）**

**实测结论**：源码态 dev 里 checkpoint 与业务库物理分离（`meshbot-config.service.ts:98-108`）：
- `$MESHBOT_HOME/accounts/<id>/agent.db` = 纯 checkpoint 库（只有 `checkpoints`/`writes` 两表）
- `$MESHBOT_HOME/main.db` = TypeORM 业务库（`cloud_identity`/`model_configs`/`sessions`/...）

盘点数据（`MESHBOT_HOME=/Users/grant/Meta1/meshbot/.meshbot`）：
- 三个账号 checkpoint 库合计约 3000+ checkpoints、5000+ writes
- **`main.db` 残留行体检非空**：2 行 `source='local'` + `provider_type='deepseek'` + `enabled=1`，
  且无任何 `source='cloud'` 行。经与用户确认（云网关眼验前配好），这 2 行**现在就删**。
- 备份：`accounts/` tar（272MB）+ `main.db` 的 `model_configs` dump，均在 scratchpad
  `checkpoint-backup-langchain1x/`。

- [x] **Step 3: 清库（已执行）**

删纯 checkpoint 文件（比 DELETE 更彻底，SqliteSaver 下次 `setup()` 重建），并删 main.db 的 2 行残留：

```bash
MESHBOT_HOME=/Users/grant/Meta1/meshbot/.meshbot
rm -f "$MESHBOT_HOME"/accounts/*/agent.db "$MESHBOT_HOME"/accounts/*/agent.db-wal "$MESHBOT_HOME"/accounts/*/agent.db-shm
sqlite3 "$MESHBOT_HOME/main.db" "DELETE FROM model_configs WHERE source='local' AND provider_type NOT IN ('openai','openai-compatible');"
```

已验证：`main.db` 的 `cloud_identity`（device_token）2 行、`sessions` 8 行完好，`model_configs` 清零。

- [ ] **Step 4: 在 worktree 安装 0.x 基线依赖**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm install
```

预期：安装成功。会看到 `@langchain/mcp-adapters` 的 peer 警告（它要 `core ^1.0.0` + `langgraph ^1.0.0`，而基线是 core 0.3 + langgraph 0.2）——**这是基线上就存在的现象**，不是本次引入的，记进 `baseline.md`。

- [ ] **Step 5: 采集基线，写入 scratchpad**

逐条跑，把**完整输出**（不是 `tail`，不是 `grep`）看完再记录：

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm typecheck                                   # 预期：全绿
npx jest apps/server-main/src/model-gateway      # 预期：全绿
npx jest apps/server-agent libs/common           # 预期：全绿
pnpm --filter @meshbot/lib-agent test            # 预期：约 9 个预存在失败
pnpm check                                       # 预期：九个围栏全绿
```

把结果写进 `<scratchpad>/baseline.md`，**`libs/agent` 的失败用例必须逐个列出全名**（后续判回归靠 diff 这个集合，不是靠"是否全绿"）。

- [ ] **Step 6: 提交 spec 勘误**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
git add docs/superpowers/specs/2026-07-10-langchain-1x-s0-s1-design.md
git commit --no-verify -m "docs: 修正 langchain 1.x spec+plan 的实测偏差

- checkpoint 与业务库物理分离：源码态 dev 下 accounts/<id>/agent.db 是纯
  checkpoint 库，业务数据在 main.db，清 checkpoint 直接 rm 文件即可，
  main.db 的 device_token/会话不碰（原「同库绝不能 rm」是打包态才成立）
- 残留行体检对象是 main.db 的 model_configs（复数），不是 account agent.db
- pnpm check 是九个围栏不是六个
- 记录 S0 实测：删了 2 行 local deepseek 残留配置，dev 云网关眼验前配好"
```

> `--no-verify`：worktree 的 husky pre-commit 走 lint-staged，纯 docs 提交无需 Biome。后续含源码的提交**不要**加这个标志。

---

## Task 1: server-main provider 构建期冒烟测（0.x 基线上先绿）

**Files:**
- Create: `apps/server-main/src/model-gateway/provider-smoke.spec.ts`

**Interfaces:**
- Consumes: `initChatModel` from `langchain/chat_models/universal`（与 `model-gateway.service.ts:130` 同一调用形状）
- Produces: 一张**表征测试网**。Task 3 抬版本后这张网必须仍绿；它是 anthropic / google-genai / ollama 三个无法真实眼验的 provider 的唯一保障。

**为什么先在 0.x 上写：** 这是**表征测试**（characterization test），不是 TDD 的失败测试。先在旧版本上钉住"现在是什么行为"，升级后必须仍然是这个行为。先写实现再补测试的话，测试会被写成"迎合新版本"，失去发现回归的能力。

**注意** `model-gateway.service.spec.ts:9-11` 把 `initChatModel` 整个 mock 掉了。本文件**绝不能** mock 它——冒烟测的全部价值就在于真的去动态 import 厂商包。

**为什么 libs/agent 侧不用新写：** spec §5.4 要求 libs/agent 侧也有一条 `openai` + `buildCloudFetch` 的冒烟。勘查发现 `libs/agent/src/graph/llm.factory.spec.ts:99-147` **已经是这条测试**——它建真 client、桩掉 `globalThis.fetch`、断言 `Authorization` 被换成 device token。它就是云网关客户端契约的守门测试，S1 全程必须保持绿。本 Task 只补 server-main 侧缺失的那半。

- [ ] **Step 1: 写冒烟测**

Create `apps/server-main/src/model-gateway/provider-smoke.spec.ts`:

```ts
import { HumanMessage } from "@langchain/core/messages";
import { initChatModel } from "langchain/chat_models/universal";

/**
 * Provider 构建期冒烟测（不联网）。
 *
 * 为什么需要：网关经 `initChatModel` 动态加载厂商包，而它的签名是
 * `initChatModel(model: string, fields?: Partial<Record<string, any>> & {...})`
 * —— `configuration` / `streaming` / `modelKwargs` 全部逃过 typecheck，
 * 全仓也没有任何一处 `new ChatOpenAI` 让编译器抓到 provider 的破坏性变更。
 *
 * 升级 langchain 大版本时，这里是唯一能在不联网、无真实 apiKey 的前提下
 * 发现下列四类破坏的防线：
 *   1. 动态 import 挂了（包名/导出路径变了）
 *   2. 构造参数改名（apiKey / streaming / configuration）
 *   3. bindTools 签名或入参格式变了
 *   4. configuration.fetch 不再被底层 client 使用（云网关的地基）
 *
 * 本文件**刻意不 mock** `initChatModel`（对比 model-gateway.service.spec.ts）。
 */

/** 与 model-gateway.service.ts:19-22 的 PROVIDER_MODEL_NAME 映射保持一致。 */
const PROVIDER_CASES = [
  {
    providerType: "openai",
    modelProvider: "openai",
    model: "gpt-4o",
    apiKey: "sk-fake",
  },
  {
    providerType: "anthropic",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "sk-ant-fake",
  },
  {
    providerType: "deepseek",
    modelProvider: "deepseek",
    model: "deepseek-chat",
    apiKey: "sk-fake",
  },
  {
    providerType: "google",
    modelProvider: "google-genai",
    model: "gemini-2.0-flash",
    apiKey: "fake-key",
  },
  {
    providerType: "ollama",
    modelProvider: "ollama",
    model: "llama3.2",
    apiKey: "unused",
  },
];

/** 网关把 OpenAI 线格式的 tools 原样喂给 bindTools，见 model-gateway.service.ts:140。 */
const OPENAI_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

/** OpenAI 线格式的固定 completion 响应，供桩 fetch 返回。 */
function cannedCompletion(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion",
      created: 0,
      model: "smoke",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("provider 构建期冒烟（不联网）", () => {
  it.each(PROVIDER_CASES)(
    "$providerType：动态 import 成功、能构建、能 bindTools",
    async ({ modelProvider, model, apiKey }) => {
      const chat = await initChatModel(model, {
        modelProvider,
        apiKey,
        streaming: false,
      });

      expect(typeof (chat as { invoke?: unknown }).invoke).toBe("function");
      expect(typeof (chat as { stream?: unknown }).stream).toBe("function");
      expect(() => chat.bindTools([OPENAI_TOOL])).not.toThrow();
    },
  );

  // configuration.fetch 只对 OpenAI 兼容线（openai / deepseek）生效——
  // anthropic 用 clientOptions、google-genai 与 ollama 各有自己的传输层。
  // 云网关的 buildCloudFetch / deepseekReasoningFetch 都挂在这条线上。
  const FETCH_WIRED = PROVIDER_CASES.filter((c) =>
    ["openai", "deepseek"].includes(c.modelProvider),
  );

  it.each(FETCH_WIRED)(
    "$providerType：configuration.fetch 被底层 client 真正使用，且 completion 可解析",
    async ({ modelProvider, model, apiKey }) => {
      const fetchSpy = jest.fn(async () => cannedCompletion());

      const chat = await initChatModel(model, {
        modelProvider,
        apiKey,
        streaming: false,
        configuration: {
          baseURL: "https://provider.invalid/v1",
          fetch: fetchSpy,
        },
      });

      const res = await chat.invoke([new HumanMessage("ping")]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(res.content).toBe("pong");
    },
  );
});
```

- [ ] **Step 2: 在 0.x 基线上跑，确认全绿**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
npx jest apps/server-main/src/model-gateway/provider-smoke.spec.ts --verbose
```

预期：7 个用例全 PASS（5 个构建 + 2 个 fetch）。

**若某个 provider 在基线上就失败**（最可能是 `ollama` 的 `bindTools` 不吃 OpenAI 线格式的 tool）：
这是**基线的既有现实**，不是本次引入的问题。处理方式是**调整测试去描述现实**，而不是改生产代码：
把该 case 从 `bindTools` 断言里摘出去，写成单独的 `it`，并在注释里写清「基线即如此，`<报错原文>`」。
把这件事记进 `baseline.md`。**不要**为了让测试变绿去动 `model-gateway.service.ts`。

- [ ] **Step 3: 格式化并提交**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm check:format
npx jest apps/server-main/src/model-gateway/provider-smoke.spec.ts
git add apps/server-main/src/model-gateway/provider-smoke.spec.ts
git commit -m "test(gateway): provider 构建期冒烟测，补 initChatModel 的 typecheck 盲区

initChatModel 签名是 Partial<Record<string,any>>，且全仓无一处 new ChatOpenAI，
provider 包的破坏性变更编译期完全不可见。用假 apiKey + 桩 fetch 钉住四件事：
动态 import、构造参数、bindTools 签名、configuration.fetch 被底层 client 使用。

先在 0.x 基线上跑绿，作为 langchain 1.x 升级的表征测试网。"
```

---

## Task 2: libs/agent 瘦身 —— provider 白名单守卫（仍在 0.x）

**Files:**
- Modify: `libs/agent/src/graph/llm.factory.ts`
- Modify: `libs/agent/src/graph/llm.factory.spec.ts`
- Modify: `libs/agent/src/graph/model-resolver.service.ts:143-150`
- Modify: `libs/agent/tests/unit/model-resolver-override.test.ts`
- Modify: `libs/agent/package.json`

**Interfaces:**
- Consumes: `ActiveModelConfig`（`libs/agent/src/config/model-config.reader.ts:14-25`），字段 `providerType / model / apiKey / baseUrl / isCloudModel`
- Produces: `createChatModel(config: ActiveModelConfig, options?: { streaming?: boolean; cloudTokenProvider?: () => string | null }): Promise<BaseChatModel>` —— **注意 `modelKwargs` 选项被移除**（唯一消费者是被删的 deepseek 分支）

**为什么这个 Task 在升级之前：** 它与 langchain 版本完全无关，可以在 0.x 上做完并跑绿。先做它能把 Task 3 的爆炸半径缩小——Task 3 出问题时，你确定不是瘦身引起的。

**hoisted 陷阱（必读）：** 从 `libs/agent/package.json` 删掉 `@langchain/deepseek` **不会**让 `initChatModel("deepseek")` 报 `ERR_MODULE_NOT_FOUND`。`apps/server-main` 仍依赖它，而 `pnpm-workspace.yaml` 的 `nodeLinker: hoisted` 把它提到根 `node_modules` 供全仓共享。所以 package.json 的删除只是**声明意图**，真正的强制手段是下面这个白名单守卫抛错。

- [ ] **Step 1: 写失败的守卫测试**

在 `libs/agent/src/graph/llm.factory.spec.ts` 末尾追加：

```ts
describe("createChatModel：本地轨 provider 白名单", () => {
  // 本地轨只经云网关取模型：model-config-sync.service.ts:119-130 的 toGatewayRow
  // 把下发行的 providerType 固定写成 openai-compatible，真实厂商调用发生在
  // server-main 的 model-gateway。所以本地轨出现其他 providerType 一定是脏数据。
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
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm --filter @meshbot/lib-agent test -- llm.factory
```

预期：前两个用例 FAIL —— `createChatModel` 现在会成功返回一个 `ChatAnthropic` / `ChatDeepSeek`，不抛错。这正是 hoisted 陷阱的现场证明。

- [ ] **Step 3: 收敛白名单并加守卫**

编辑 `libs/agent/src/graph/llm.factory.ts`。

把 `:9-22` 的映射表整段替换成：

```ts
/**
 * 本地轨 providerType → initChatModel 期望的 modelProvider 名。
 *
 * 本地轨只经云网关取模型：`model-config-sync.service.ts` 的 `toGatewayRow` 把云端
 * 下发行的 providerType 固定写成 `openai-compatible`，真实厂商（anthropic /
 * google-genai / ollama / deepseek）的调用发生在 server-main 的 model-gateway。
 * 因此这里只需支持 OpenAI 兼容协议一种。
 */
const PROVIDER_MODEL_NAME: Record<string, string> = {
  openai: "openai",
  "openai-compatible": "openai",
};
```

把 `:126-170` 的 `createChatModel` 整个函数替换成：

```ts
export async function createChatModel(
  config: ActiveModelConfig,
  options?: {
    /** 覆盖 streaming，title / one-shot 场景设 false 跳过 stream 开销。 */
    streaming?: boolean;
    /**
     * 云网关模型（`config.isCloudModel`）取当前 device token 的回调。
     * 每次请求都会重新调用，token 轮换无需重建 client；不传时云模型请求
     * 会带空 Bearer。
     */
    cloudTokenProvider?: () => string | null;
  },
): Promise<BaseChatModel> {
  // 白名单守卫必须显式抛错：hoisted 模式下厂商包仍物理存在于根 node_modules
  // （server-main 依赖它们），不拦的话 initChatModel 会静默建出一个本地直连
  // client，把请求打到厂商而绕过云网关。
  const modelProvider = PROVIDER_MODEL_NAME[config.providerType];
  if (!modelProvider) {
    throw new Error(
      `本地轨不支持的 providerType：${config.providerType}。` +
        `本地轨只经云网关取模型，真实厂商调用发生在 server-main 的 model-gateway；` +
        `请检查 model_configs 表是否残留 source='local' 的旧行。`,
    );
  }

  const configuration: Record<string, unknown> = {};
  if (config.baseUrl) configuration.baseURL = config.baseUrl;
  // 云网关模型：apiKey 落地的是占位符（真实厂商 key 只在云端持有），client
  // 用占位 key 建一次即可；每次请求靠 fetch 包装把 Authorization 换成当前
  // device token，避免把易失效的 token 提前烘进 client 实例。
  if (config.isCloudModel) {
    configuration.fetch = buildCloudFetch(
      globalThis.fetch,
      options?.cloudTokenProvider ?? (() => null),
    );
  }
  return (await initChatModel(config.model, {
    modelProvider,
    apiKey: config.apiKey,
    ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
    streaming: options?.streaming ?? true,
    ...(debugCallback ? { callbacks: [debugCallback] } : {}),
  })) as BaseChatModel;
}
```

删掉 `:172-206` 的整个 `patchedFetchForDeepseek` 函数（含其 JSDoc）。它唯一的调用点是刚被删的
`config.providerType === "deepseek"` 分支；本地轨永不出现该 providerType。云网关侧的同名逻辑
在 `apps/server-main/src/model-gateway/deepseek-fetch.ts`，是**另一份独立实现**，保留不动。

同时 `modelKwargs` 选项也被移除了——它唯一的消费者是下一步要删的 deepseek thinking-disable 分支。
S3 若需要再加回来。

- [ ] **Step 4: 删 model-resolver 的 deepseek 分支**

`libs/agent/src/graph/model-resolver.service.ts:143-150`，把：

```ts
    const modelKwargs =
      cfg.providerType === "deepseek"
        ? { thinking: { type: "disabled" } }
        : undefined;
    const model = await createChatModel(cfg, {
      streaming: false,
      modelKwargs,
      cloudTokenProvider: this.cloudTokenProvider,
    });
```

替换成：

```ts
    const model = await createChatModel(cfg, {
      streaming: false,
      cloudTokenProvider: this.cloudTokenProvider,
    });
```

**行为不变的论证**：云模型的 `providerType` 恒为 `openai-compatible`（`toGatewayRow`），本地直连写入
REST 已下线，所以 `cfg.providerType === "deepseek"` 在删除前就不会命中，`modelKwargs` 恒为
`undefined`。删除它不改变任何运行时行为。若产品上确实要在 title 生成时关掉 deepseek thinking，
正确落点是云网关侧，属 S3/S4。

- [ ] **Step 5: 跑测试，确认守卫用例通过、override 用例变红**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm --filter @meshbot/lib-agent test
```

预期：
- `llm.factory.spec.ts` 的三个新用例全 PASS
- `llm.factory.spec.ts:99-147` 那个既有的云 fetch 端到端用例仍 PASS（**它是云网关客户端契约的守门测试，任何时候都不许红**）
- `model-resolver-override.test.ts` 的「覆盖 id 优先且可用未启用配置」**变红**——它的 fixture 用了 `providerType: 'deepseek'`，而 `resolveModel()`（`model-resolver.service.ts:97-122`）会走到 `createChatModel` 撞上新守卫

- [ ] **Step 6: 把 override 测试的 fixture 换成 openai-compatible**

`libs/agent/tests/unit/model-resolver-override.test.ts`。

`:25-27` 的 INSERT 改成：

```ts
    db.prepare(
      `INSERT INTO model_configs (id, cloud_user_id, provider_type, name, model, api_key, enabled)
       VALUES ('mc-default','u1','openai','默认','gpt-a','k',1),
              ('mc-alt','u1','openai-compatible','备用','ds-b','k',0)`,
    ).run();
```

`:61-66` 的断言改成：

```ts
        expect(resolver.getMeta()).toEqual({
          providerType: "openai-compatible",
          model: "ds-b",
        });
```

> `deepseek` 在这个测试里只是个**通用 fixture**（测的是"覆盖 id 优先"和"meta 写进 run 上下文"，
> 与 provider 语义无关），换成白名单内的值不损失任何覆盖度。

跑一遍全文件，若还有别的 deepseek fixture 撞守卫，同样处理：

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
grep -rn "deepseek" libs/agent/tests libs/agent/src --include="*.ts" | grep -v "\.md"
```

对每处判断：它是否会走到 `createChatModel`？会 → 换成 `openai-compatible`；不会（只是 meta/统计数据）→ 不动。

- [ ] **Step 7: 从 libs/agent/package.json 删掉四个 provider 包**

`libs/agent/package.json` 的 `dependencies` 删掉这四行：

```json
    "@langchain/anthropic": "0.3.34",
    "@langchain/deepseek": "0.1.0",
    "@langchain/google-genai": "0.2.18",
    "@langchain/ollama": "0.2.4",
```

然后：

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm install
```

预期：`pnpm-lock.yaml` 的 `libs/agent` importer 段少掉四条；根 `node_modules` 里这四个包**仍然存在**
（server-main 依赖它们，hoisted 共享）。这正是 Step 3 守卫存在的理由。

- [ ] **Step 8: 全面回归并提交**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm check:format
pnpm typecheck
pnpm --filter @meshbot/lib-agent test    # 失败集合必须与 baseline.md 一致（不多不少）
npx jest apps/server-agent apps/server-main libs/common
pnpm check
```

四条全部符合预期后：

```bash
git add libs/agent apps pnpm-lock.yaml
git commit -m "refactor(agent): 本地轨收敛到 OpenAI 兼容协议单 provider

本地轨只经云网关取模型（toGatewayRow 把下发行固定写成 openai-compatible），
真实厂商调用发生在 server-main 的 model-gateway。据此：

- PROVIDER_MODEL_NAME 收敛为 openai / openai-compatible，未知 providerType 显式抛错
- 删 patchedFetchForDeepseek 与 model-resolver 的 deepseek thinking-disable 分支（死代码）
- 删 createChatModel 的 modelKwargs 选项（唯一消费者是上面那个分支）
- libs/agent 移除 anthropic / deepseek / google-genai / ollama 四个依赖

hoisted 模式下这四个包仍物理存在于根 node_modules（server-main 依赖），
删 package.json 只是声明意图，真正的强制手段是白名单守卫抛错。

行为不变：deepseek 分支在删除前就不会命中（云模型 providerType 恒为 openai-compatible）。"
```

---

## Task 3: 原子依赖升级 + 编译修复

**Files:**
- Modify: `libs/agent/package.json`
- Modify: `apps/server-agent/package.json:23`
- Modify: `apps/server-main/package.json:16-21,44`
- Modify: `pnpm-workspace.yaml`
- Modify: 编译报错所指的源码文件（**具体清单在 Step 3 实测后才知道**）

**Interfaces:**
- Consumes: Task 1 的冒烟测网、Task 2 的白名单守卫、Task 0 的 `baseline.md`
- Produces: 一棵全 1.x 的依赖树，且全部测试与围栏回到 baseline 水平

**诚实声明：** 这个 Task 里「改哪些源码文件」**无法在实测前枚举**。core 1.x 把 `AIMessage` /
`AIMessageChunk` 泛型化了（`<TStructure extends MessageStructure>`），泛型推断会在哪些调用点渗出
类型噪音，只有编译器知道。下面 Step 4 给出了**已经从 `.d.ts` 里核实过的、可预测的破坏点及其修法**，
Step 5 给出未预测破坏的处置纪律。不要因为计划没列出某个报错就停下——按纪律处理并记录。

- [ ] **Step 1: 改四个依赖声明文件**

`libs/agent/package.json` 的 `dependencies` 中，langchain 相关改成（注意 `@langchain/openai` **不带 `^`**）：

```json
    "@langchain/core": "^1.2.2",
    "@langchain/langgraph": "^1.4.7",
    "@langchain/langgraph-checkpoint": "^1.1.3",
    "@langchain/langgraph-checkpoint-sqlite": "^1.0.3",
    "@langchain/mcp-adapters": "^1.1.3",
    "@langchain/openai": "1.5.5",
    "langchain": "^1.5.3",
```

`apps/server-agent/package.json:23`：

```json
    "@langchain/core": "^1.2.2",
```

`apps/server-main/package.json` 的 `:16-21` 与 `:44`：

```json
    "@langchain/anthropic": "1.5.1",
    "@langchain/core": "^1.2.2",
    "@langchain/deepseek": "1.1.5",
    "@langchain/google-genai": "2.2.0",
    "@langchain/ollama": "1.3.0",
    "@langchain/openai": "1.5.5",
```

```json
    "langchain": "^1.5.3",
```

`pnpm-workspace.yaml` 的 `overrides`，把 checkpoint 那行连同注释改成：

```yaml
  # langgraph 1.x 全家对齐到 checkpoint 1.1.x：langgraph@1.4.7 依赖 ^1.1.3，
  # checkpoint-sqlite@1.0.3 peer 要 ^1.0.0，langchain@1.5.3 依赖 ^1.1.3。
  # hoisted 单副本下必须钉死，避免 checkpoint 序列化跨副本失配。
  '@langchain/langgraph-checkpoint': ^1.1.3
```

`better-sqlite3: ^12.9.0` 那条 override **保留不动**。`checkpoint-sqlite@1.0.3` 依赖
`better-sqlite3: ^12.10.0`，而 `^12.9.0` 的范围能解析到 12.10+，同大版本 ABI 不变。

- [ ] **Step 2: 装依赖**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm install
```

预期：安装成功。`@langchain/mcp-adapters` 的 peer 警告**应当消失**——它要 `core ^1.0.0` +
`langgraph ^1.0.0`，升级后首次被满足（基线上它一直跑在未声明支持的组合上）。

核对单副本（hoisted 下必须各只有一份）：

直接数 lockfile 里出现过几个版本，比 `pnpm why` 的树状输出更好判读：

```bash
grep -E "^  @langchain/(core|openai|langgraph|langgraph-checkpoint)@" pnpm-lock.yaml | sort -u
```

预期每个包各出现**一个版本**：`@langchain/core@1.2.x`、`@langchain/openai@1.5.5`、
`@langchain/langgraph@1.4.x`、`@langchain/langgraph-checkpoint@1.1.x`。

**若 `@langchain/openai` 出现两份**（例如 1.5.5 + 1.5.6），说明哪里写成了 `^1.5.5`：
`@langchain/deepseek@1.1.5` 硬钉 `"@langchain/openai": "1.5.5"` 精确版本，`^` 会让根 hoist 到更高
的补丁版、deepseek 再自带一份 1.5.5。两份 openai 各自 peer 到同一个 core，`instanceof` 与
checkpoint 序列化都会在跨副本边界上静默出错。回 Step 1 改成精确版本。

- [ ] **Step 3: 跑 typecheck，把破坏面落到文件**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm typecheck 2>&1 | tee /tmp/lc1x-typecheck.txt
```

**完整读一遍输出**，不要只看 `tail`——turbo 的退出码和末尾摘要会掩盖上游包的真实失败。
把报错按「文件 → 报错类型」归类，写进 `<scratchpad>/breakage.md`。

- [ ] **Step 4: 修可预测的破坏点**

下面每一条都已从 1.x 的 `.d.ts` 里核实过。**只在 typecheck 真的报了对应错误时才动手**——
核实结果表明大部分符号是原地保留的，很可能一个都不需要改。

**(a) `AIMessage` / `AIMessageChunk` 泛型化。** `ai.d.ts:49` 现在是
`class AIMessageChunk<TStructure extends MessageStructure = MessageStructure>`。默认类型参数
存在，所以裸写 `AIMessageChunk` 仍合法。若 `supervisor.node.ts:63` 的 `new AIMessage({...})`
报字段类型不匹配，改成显式构造而不是加 `as any`：保留 `content` / `tool_calls` /
`response_metadata` / `usage_metadata` / `additional_kwargs` 五个字段原样传入，把报错字段
单独用局部变量断言到 `.d.ts` 里声明的类型。

**(b) `StateGraph({channels})`。** `state.d.ts:303` 保留了这条重载，但标了
`/** @deprecated Use Annotation.Root, StateSchema, or Zod schemas instead. */`。deprecated 不产生
编译错误。若 `graph.builder.ts:95-102` 真的报错（例如 `GraphState` 不满足新的 `StateDefinitionInit`
约束），**不要**加 `@ts-ignore`——把这一个文件迁到 `Annotation.Root`，并在 commit message 里标注
「S2 提前项」：

```ts
import { Annotation } from "@langchain/langgraph";

const GraphAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: mergeMessages,
    default: () => [],
  }),
});
```

然后 `new StateGraph(GraphAnnotation)`。`mergeMessages` 的签名 `(left, right) => BaseMessage[]`
与 `Annotation` 的 `reducer` 一致，逻辑不用动。

**(c) `initChatModel` 的返回类型。** 它返回 `ConfigurableModel`，`llm.factory.ts` 现有的
`as BaseChatModel` 断言仍然必要，保留。

**(d) 已核实**不需要改的（若报错说明我核错了，记进 `breakage.md` 并按 Step 5 处理）：
`RemoveMessage`（`@langchain/core/messages`）、`ChatGenerationChunk`（`@langchain/core/outputs`）、
`convertLangChainToolCallToOpenAI` 与 `parseToolCall`（`@langchain/core/output_parsers/openai_tools`）、
`ToolCallChunk`（`@langchain/core/messages/tool`）、`SqliteSaver` 的 `constructor(db, serde)` 与公开
字段 `db: Database`、`MultiServerMCPClient`、`additional_kwargs` / `response_metadata` /
`usage_metadata` / `tool_calls` / `tool_call_chunks` / `AIMessageChunk.concat`。

- [ ] **Step 5: 未预测破坏的处置纪律**

对 `breakage.md` 里没被 Step 4 覆盖的每一条：

1. **最小修复，不改语义。** 目标是让它编译并保持原行为，不是顺手重构。
2. **禁止 `as any` / `@ts-ignore` 消音。** 类型对不上说明真实形状变了，消音会把运行时炸点藏到眼验阶段。
3. **若最小修复需要改动编排语义**（例如 `graph.stream` 的 `streamMode` 返回形状变了，导致
   `graph-runner.service.ts` 的 chunk 消费逻辑必须重写）——**停下来，报告，不要自行决定**。
   那已经超出「纯升级」范围。
4. 每修一条，在 `breakage.md` 里记：文件、报错原文、修法、是否影响运行时行为。

- [ ] **Step 6: 跑全部测试，与 baseline 逐项对齐**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm typecheck                                              # 必须全绿
npx jest apps/server-main/src/model-gateway --verbose        # 冒烟测 + 网关：必须全绿
npx jest apps/server-agent libs/common
pnpm --filter @meshbot/lib-agent test
pnpm check
```

判定标准：

- `pnpm typecheck` / `pnpm check` / server-main / server-agent / libs/common：**全绿**
- `libs/agent` vitest：失败集合与 `baseline.md` **完全一致**（不多不少）。多一个都是回归；少一个也要弄清为什么。
- **`provider-smoke.spec.ts` 必须全绿**——这是 anthropic / google-genai / ollama 三个无法眼验的 provider 的唯一保障。
- **`llm.factory.spec.ts:99-147` 的云 fetch 端到端用例必须绿**——它钉住的是云网关客户端契约。

- [ ] **Step 7: 提交**

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm check:format
pnpm typecheck
git add -A
git commit -m "feat(deps): langchain 生态原子升级到 1.x

core 0.3.80 → 1.2.2 / langgraph 0.2.74 → 1.4.7 / checkpoint 0.0.18 → 1.1.3 /
checkpoint-sqlite 0.1.5 → 1.0.3 / langchain 0.3.37 → 1.5.3 /
openai 0.6.17 → 1.5.5（精确钉，deepseek@1.1.5 硬依赖此确切版本）/
anthropic → 1.5.1 / deepseek → 1.1.5 / google-genai → 2.2.0 / ollama → 1.3.0

必须原子：langgraph@0.2 的 peer 是 core >=0.3.40 <0.4.0，每个 0.x provider 都是
core ^0.3，而 langchain@1.5.3 把 langgraph ^1.4.7 列为硬依赖。叠加 nodeLinker:hoisted
的单副本约束，不存在既能编译又能跑的中间状态。

行为零变化：reasoning 仍读 additional_kwargs.reasoning_content，
StateGraph 仍用 {channels} 重载，checkpointer 仍直取 .db，
instanceof AIMessageChunk 保留。现代化清理留给 S2。

副作用：@langchain/mcp-adapters@1.1.3 的 peer（core ^1.0.0 + langgraph ^1.0.0）
首次被满足——基线上它一直跑在未声明支持的组合上。"
```

---

## Task 4: 全量回归与端到端眼验

**Files:** 无源码改动（除非眼验发现问题）

**Interfaces:**
- Consumes: Task 3 的 1.x 依赖树
- Produces: S1「完成」的证据。

**眼验前提：** worktree 有自己的 `pnpm-workspace.yaml`，`findRepoRoot` 会把它当仓库根，导致 dev 用
worktree 内一个**全新的空 `.meshbot`**（没有 device token，登录态为空）。必须显式设 `MESHBOT_HOME`
指向主仓那份已授权的数据。

- [ ] **Step 1: desktop 原生模块 ABI 验证**

`checkpoint-sqlite@1.0.3` 把 `better-sqlite3` 从 `^11.7.0` 拉到 `^12.10.0`。override 仍是 `^12.9.0`，
解析结果会落到 12.10+。同大版本 ABI 不变，但 Electron 打包链路要实测。

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm build:desktop
pnpm rebuild:native
```

预期：`electron-rebuild` 编译 `better-sqlite3` 成功，无 v8 头文件报错。

- [ ] **Step 2: 起三端**

server-main 跑的是编译产物 `dist/main`，**改了源码必须重新 build 才生效**（不是纯 watch 热更）。

三个终端窗口，全部 `cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x`：

```bash
# 终端 1：云端后端（需要 postgres）
pnpm dev:db:up
pnpm build:server-main && pnpm start:server-main

# 终端 2：本地 Agent 后端 —— 注意 MESHBOT_HOME
MESHBOT_HOME=/Users/grant/Meta1/meshbot/.meshbot pnpm dev:server-agent

# 终端 3：桌面端 UI
pnpm dev:web-agent
```

- [ ] **Step 3: 逐项眼验**

浏览器开 `http://localhost:3001`，用**云 DeepSeek 模型**（经网关）逐条确认。每条都要真的看到，
不能推断：

- [ ] 新建会话，发一句话 → 助手**逐字流式**出现（不是一次性整段蹦出）
- [ ] 回复结束后 token 用量气泡**非 0**（验证 usage 末帧透传）
- [ ] 追问第二轮 → 上下文连贯（验证 checkpoint 读写在 1.x 下正常，S0 清库后从零重建）
- [ ] 让它读一个文件（触发工具调用）→ 工具卡片正常展开、结果正常回填
- [ ] 触发一次需要确认的工具（HITL 确认卡）→ 卡片弹出、点确认后继续执行
- [ ] 触发一次 `ask_question` → 选项渲染正常、选完继续
- [ ] 触发子 agent dispatch → 子任务卡片正常
- [ ] 配了 MCP 的话，调一个 MCP 工具 → 正常（`mcp-adapters` 的 peer 刚刚才被满足，重点看）
- [ ] **reasoning 行为与升级前一致**：DeepSeek 思考链此刻**仍然不显示**（S1 不动 reasoning，
      这是预期；S3 才让它显示）

**若「有回复但页面不显示、chunks=0」**：这是已知的老地雷——网关流式首帧必须带 `role:"assistant"`
（`model-gateway.service.ts:97`），否则端侧建成 generic `ChatMessageChunk`，被
`graph-runner.service.ts` 的 `instanceof AIMessageChunk` 丢弃。1.x 下 `ChatOpenAI` 产出的 chunk
类身份可能变了。修法是把 `instanceof AIMessageChunk` 换成 core 1.x 提供的
`isAIMessageChunk(chunk)`（从 `@langchain/core/messages` 导入）——这本是 S2 的活，
若 S1 撞上就提前做，并在 commit message 标注「S2 提前项」。

- [ ] **Step 4: 记录并提交回归结论**

把 Step 1-3 的实际结果（含任何 S2 提前项）追加到
`docs/superpowers/plans/2026-07-10-langchain-1x-s0-s1.md` 末尾的「S1 回归结论」一节，
连同任何为了让眼验通过而做的代码修复一起提交：

```bash
cd /Users/grant/Meta1/meshbot/.claude/worktrees/langchain-1x
pnpm check:format
pnpm typecheck
pnpm check
git add -A
git commit -m "test: S1 全量回归与端到端眼验通过

<在此逐条写实际验证到的现象，以及任何 S2 提前项>"
```

- [ ] **Step 5: 向用户报告，等待下一阶段指令**

报告内容必须包含：

1. `libs/agent` vitest 失败集合 vs baseline 的 diff（应为空）
2. `provider-smoke.spec.ts` 的 7 个用例结果
3. 眼验清单逐条的实际观察
4. `breakage.md` 里所有「影响运行时行为」的条目
5. **7.1 风险清单**：anthropic / google-genai / ollama 在网关侧仍属**未真实验证**状态
   （无 apiKey），只有冒烟测兜底；`google-genai` 还跨了 0.2 → 2.2 两个主版本
6. 埋雷提醒：`ChatOpenAI` 1.x 在模型名含 `gpt-5.2-pro` / `gpt-5.4-pro` / `gpt-5.5-pro` / `codex`
   时会自动改打 `/responses`，而云网关只实现了 `/chat/completions`

**不要自动开始 S2。** 单分支连续提交，等用户指示。

---

## S1 回归结论

<!-- Task 4 Step 4 填写 -->
