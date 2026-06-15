# 本地 Agent 数据按云端账号隔离 —— 设计文档（v3：单进程 + 多账号并发运行时 + 字段隔离 + 请求级作用域）

- 日期:2026-06-15
- 状态:设计已确认（v3 取代 v2），待产出实现计划
- 范围:`apps/server-agent`、`libs/agent`、`apps/web-agent`、`apps/desktop`
- 版本演进:
  - **v1**(作废):物理隔离 / 每账号一进程 / 进程池 + 反向代理。
  - **v2**(被本版取代):单进程 + **单一全局活跃账号**(D3)+ 切账号 reload。
  - **v3**(本版):单进程 + **多账号并发常驻运行时** + **请求级账号作用域**。推翻 v2 的 D3「同一时刻一个活跃账号」。产品确认需要「同机多账号同时在线」(如 desktop 一个账号 + 浏览器另一个账号做多人对话调试),接受其加载/内存复杂度。

## 1. 背景与问题

本地轨当前按**单用户**设计:`Session` 等表无归属字段、本地会话是扁平共享池,`CloudIdentity` 单行(`id='default'`)。实测两个云端账号登录看到同一批本地会话。目标:**一个云端账号 = 一套独立本地数据**,且**多账号可在同一进程内并发在线**。

## 2. 为什么选「单进程 + 多账号并发运行时 + 字段隔离」

- **运行时热加载是独立硬需求**:产品后续要让用户通过 Agent 对话修改提示词 / 安装移除技能 / 配置 MCP,要求不重启进程动态重载。这套机制无论是否多账号都得建。
- **并发多账号是确认的产品需求**:同机多账号同时在线(多人对话本地调试)。因此 v2 的「单一活跃账号」不够用。
- **单库字段隔离绕开运行时换 DataSource 的难题**:DB 连接固定,隔离靠查询过滤 + 请求级账号上下文,不需要每账号一个 DataSource/进程。
- **代价(已接受)**:每个在线账号常驻一套运行时(MCP 连接 / 技能 / 提示词缓存 / 云端连接),内存与复杂度随在线账号数增长;登出必须显式 teardown 释放。

## 3. 已确认的设计决策

- **D1 单进程**:一个常驻 server-agent,**永不为账号变化重启**,固定监听 3100。web-agent 直连 3100,前端连接方式不变。
- **D2 共享 DB + 字段隔离**:一个 `~/.meshbot/agent.db`;按账号隔离的表加 `cloud_user_id`,查询按**当前请求/任务的账号**过滤。
- **D3(v3 改写)多账号并发活跃**:**不存在单一全局活跃账号**。多个账号可同时登录、各自运行时常驻。账号归属按**请求(本地 JWT 的 sub)/后台任务(任务所属账号)**逐次解析。
- **D4 每账号运行时 + 生命周期**:每个在线账号一套 `AccountRuntime`(MCP clients / 技能缓存 / 提示词缓存 / 云端连接)。**登录 → 构建并注册;登出 → teardown 并注销**(断 MCP、清技能/提示词缓存、关云端连接)。
- **D5 登录必须**:无匿名桶;已登录后离线仍可用(token 缓存)。
- **D6 不防偷看**:同 OS 用户能读所有账号数据;无静态加密。本设计是正确性/归属隔离,非安全边界。
- **D7 不迁移**:升级后从空开始(旧单用户数据因缺 `cloud_user_id` 被过滤,等同消失;文件留盘)。
- **D8(v3 改写)CronJob 按账号并发**:**每个已登录账号的 CronJob 都在其账号上下文并发跑**;某账号登出 → 其运行时 teardown → 其 cron 随之停。
- **D9(v3 新增)重启恢复**:进程 boot 时遍历「已登录账号集合」,逐个重建运行时(重连 MCP + 恢复 cron + 连云)。
- **D10(v3 新增)账号上下文来源**:请求经本地 JWT 鉴权后,从 `sub`(=cloudUserId)注入 `AsyncLocalStorage`;scoped 查询 / 文件 getter / 运行时取数都从该上下文读。**无 `/api/accounts/switch` 端点、无全局活跃指针**。客户端各持自己账号的 token,多 token = 多账号并发(desktop 持 A 的 token、浏览器持 B 的 token,都打 :3100 也各自正确)。

## 4. 架构概览

```
单个 server-agent 进程（:3100，永不为账号变化重启）
├─ AccountRuntimeRegistry：Map<cloudUserId, AccountRuntime>
│    AccountRuntime = { MCP clients, 技能缓存, 提示词缓存, 云端连接 }
│    登录 → createRuntime(cloudUserId)；登出 → teardownRuntime(cloudUserId)
├─ AccountContext（AsyncLocalStorage）：每请求/任务的 cloudUserId
│    请求：本地 JWT sub 注入；后台（cron/runner）：执行前显式 set
├─ DB：共享 ~/.meshbot/agent.db，按账号表带 cloud_user_id，查询按上下文账号过滤
└─ 文件（按上下文账号解析）：accounts/<cloudUserId>/{skills,prompt,mcp.json,workspace}

~/.meshbot/
├── agent.db                      # 共享，字段隔离
└── accounts/<cloudUserId>/       # 仅文件型，每账号一套
    ├── skills/  prompt/  mcp.json  workspace/
```

## 5. 数据模型变更

- 给**按账号隔离的表**加 `cloud_user_id`(snake_case):`sessions` / `session_messages` / `pending_messages` / `llm_calls` / `model_configs` / `settings` / `cron_jobs`。
- `CloudIdentity` 由**单行**(`id='default'`)改为**多行**(主键 = `cloud_user_id`),保存各账号云端 token/镜像;新增 `logged_in` 布尔列标记「当前是否登录」(区别于「有缓存 token」——登出后行保留、token 留存,但 `logged_in=false`)。
- **已登录账号集合 = `cloud_identity` 中 `logged_in=true` 的行**。D9 重启恢复即遍历这批行重建运行时。**不再需要 v2 的 `app_state(active_account)` 全局指针表**(v3 无单一活跃账号)。
- LangGraph checkpointer 的 `checkpoints`/`writes` 表**不加列**:thread_id(=session id)全局唯一,会话列表按 `cloud_user_id` 过滤后,他账号的 thread_id 不可达 → **传递式隔离**。
- **SQLite 迁移**(TypeORM):7 表加列 + 多行 CloudIdentity(主键迁移 + `logged_in` 列)。旧单用户数据无 `cloud_user_id` → 被过滤,符合 D7「从空开始」。

## 6. 账号作用域与防串数据(核心风险,v3 风险更高)

并发多账号下「漏过滤 → 跨账号实时串台」是唯一真实风险且更危险。缓解:**集中式作用域 + 请求级上下文**,绝不靠每个查询各自记得加 `where`。

- 一个 `AccountContextService` 基于 `AsyncLocalStorage` 持有「当前上下文 cloudUserId」。
  - 请求路径:本地 JWT 鉴权 guard 通过后,用 `sub`(=cloudUserId)`run()` 包裹后续处理。
  - 后台路径:cron 执行器 / runner 在跑某账号任务前,显式 `run(cloudUserId, fn)`。
- 各 Entity 归属 Service 的查询统一经一个 **scoped helper**:读自动注入 `cloud_user_id = ctx.cloudUserId`,写自动带上 `cloud_user_id`。无上下文(系统级)时显式报错或走白名单。
- **加一个静态围栏 `check:scope`**(类比 `check:repo`):校验按账号表的查询都经 scoped helper / 带过滤,挡住裸 `find` / 裸 `createQueryBuilder` / 裸 raw query。围栏脚本须有单测。
- 写时校验:跨账号写入(上下文账号与目标行 `cloud_user_id` 不一致)直接拒绝。

## 7. 每账号文件 + 运行时注册表 + 热重载

- `MeshbotConfigService` 拆分语义:
  - **DB 路径固定共享**(`<root>/agent.db`,不随账号变)。
  - **文件 getter 账号化**:`getSkillsDir()/getPromptDir()/getMcpConfigPath()/getWorkspaceDir()` 从 `AccountContext` 取 cloudUserId → `accounts/<cloudUserId>/...`(或接受显式 cloudUserId 参数,供后台/注册表构建时用)。
  - (v1 已合入的「全树跟随 MESHBOT_HOME」对 DB 这块回退为固定共享;`MESHBOT_HOME` 仍作为顶层 root。)
- **`AccountRuntimeRegistry`**:`Map<cloudUserId, AccountRuntime>`。
  - `createRuntime(cloudUserId)`:按该账号 `mcp.json` 连 MCP、初始化技能/提示词缓存、建云端连接(IM relay)。幂等(已存在则先 teardown)。
  - `teardownRuntime(cloudUserId)`:断 MCP、清技能/提示词缓存、关云端连接,并从 registry 删除。**登出时调用** —— 满足「退出时卸载对应 MCP、技能等」。
  - `reloadRuntime(cloudUserId)`:teardown + create(用户对话改配置 / 切目录时触发)。
- **`McpService` 每账号化**:从「onModuleInit 全局起一次」改为「按 cloudUserId 维护 client 集合」,支持 per-account 的幂等 teardown + init。
- 技能/提示词缓存:按 cloudUserId 维度缓存,teardown 时失效对应键。

## 8. 登录 / 登出(无切换端点)

- **登录**(renderer → 现有 `/api/auth/login`):云端鉴权 → upsert 该账号 `CloudIdentity`(多行)+ `logged_in=true` → `createRuntime(cloudUserId)`(连 MCP/云、初始化缓存)→ 签发本地 JWT(`sub=cloudUserId`)返回。
- **登出**(`/api/auth/logout`):`teardownRuntime(cloudUserId)`(卸 MCP/技能/云连接)+ `logged_in=false` + 前端 `clearAccessToken()`。账号数据/文件留盘。
- **「切换账号」无需服务端端点**:账号由 token 决定。前端持有多个已登录账号的 token,切换 = 改用另一账号的 token(已登录的直接切;未登录的走登录流程)。
- **重启恢复(D9)**:boot 时遍历 `logged_in=true` 的账号,逐个 `createRuntime`。

## 9. CronJob(D8 v3)

- 调度执行器遍历**全部已登录账号**的到期任务:按 `cloud_user_id` 取每个在线账号的 due jobs,在该账号的 `AccountContext` 下执行(`run(cloudUserId, () => execute(job))`)。
- 某账号登出 → 其运行时 teardown → 其后续 cron 不再参与调度。
- `cron_jobs` 已在 §5 的 7 表内加 `cloud_user_id`。

## 10. 桌面壳变更(极小)

- 仍 fork **一个** server-agent(沿用 [agent-runtime.ts](../../../apps/desktop/src/agent-runtime.ts)),`MESHBOT_HOME=~/.meshbot`。**不需要进程池 / 反向代理 / 多端口**。
- 多账号逻辑全在 server-agent 内(并发运行时 + 请求级作用域 + per-account reload/teardown)。
- 同机双账号调试:desktop 渲染端持账号 A 的 token、浏览器持账号 B 的 token,均打 :3100;请求各带自己 JWT,作用域各自正确,互不串台。
- 强制登录闸已由现有 [auth-guard.tsx](../../../apps/web-agent/src/components/auth-guard.tsx) 覆盖。

## 11. 本版推翻了什么

- v1 的物理隔离 / 每账号一进程 / 进程池 / 反向代理 / WS 转发 —— 全部作废。
- v2 的 **D3 单一全局活跃账号 / `app_state` 活跃指针 / `/api/accounts/switch` 切换端点 / 单个可重载运行时** —— 作废,改为**并发运行时注册表 + 请求级账号上下文**。
- 已合入的 commit `f99c344`(MeshbotConfigService 遵循 MESHBOT_HOME)**保留**;文件 getter 进一步改为按上下文账号解析,DB 路径回退固定共享。

## 12. 测试策略

- **单元**:`AccountContextService`(run/get,无上下文报错);scoped helper 自动过滤;`MeshbotConfigService` 文件 getter 随上下文账号变化、DB 路径固定;`AccountRuntimeRegistry` create/teardown/reload 幂等;`check:scope` 围栏。
- **集成(server-agent,jest)**:**两账号并发**——两个本地 JWT 交错请求,各写各自 `cloud_user_id`,断言互不可见(会话/设置/模型配置);登出 A → 断言 A 运行时被 teardown(MCP/技能卸载)、A 的 cron 停、B 不受影响;重启恢复(D9)重建全部已登录账号。
- **围栏**:「按账号表查询必须 scoped」静态检查的单测。
- **热重载**:reload 某账号后其 MCP 按新 mcp.json 重连、技能列表来自新目录,且不影响其他账号运行时。

## 13. 实现阶段

1. **数据模型 + 迁移**:7 张表加 `cloud_user_id`;`CloudIdentity` 改多行(主键 `cloud_user_id`)+ `logged_in` 列;SQLite 迁移(去掉 v2 的 `app_state`)。
2. **请求级账号上下文 + 集中作用域 + 静态围栏**:`AccountContextService`(AsyncLocalStorage)+ JWT guard 注入 + scoped 查询封装 + `check:scope` 围栏(防漏过滤)。各归属 Service 接入。
3. **每账号运行时注册表 + 文件账号化 + 热重载**:`AccountRuntimeRegistry`(create/teardown/reload);`MeshbotConfigService` 文件 getter 账号化(DB 固定);`McpService` 每账号化 + 幂等 teardown/init。
4. **登录/登出生命周期 + 重启恢复**:登录建运行时 + 签 JWT(`sub`);登出 teardown + `logged_in=false`;boot 恢复全部已登录账号(D9)。
5. **前端**:多账号 token 管理(切换 = 换 token)+ 登录入口;登出清 token + 调后端登出;复用现有 auth-guard。
6. **CronJob 跨账号作用域**:调度遍历全部已登录账号的到期任务,各在本账号上下文执行(D8)。

## 14. 风险

- **并发漏过滤实时串台**:比 v2 更危险(并发活跃);靠 §6 集中作用域 + `check:scope` 围栏兜底;主要持续维护点。
- **运行时内存随在线账号数增长**:每在线账号一套 MCP/技能/提示词/云连接;登出必须 teardown 释放;在线账号过多需关注资源。
- **teardown / reload 时序与幂等**:登出/重载时无悬挂 MCP 连接、缓存正确失效、不误伤其他账号运行时;执行期真机验证。
- **重启恢复风暴(D9)**:多账号 boot 时同时重连 MCP/云,需限并发或容错(单账号失败不拖垮整体)。
