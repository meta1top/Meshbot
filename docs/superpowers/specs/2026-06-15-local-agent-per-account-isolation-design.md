# 本地 Agent 数据按云端账号隔离 —— 设计文档（v2：单进程 + 共享库字段隔离 + 热重载）

- 日期:2026-06-15
- 状态:设计已确认,待重做实现计划
- 范围:`apps/server-agent`、`libs/agent`、`apps/web-agent`、`apps/desktop`
- 说明:本版**推翻 v1**(物理隔离 / 每账号一进程 / 进程池 + 反向代理)。转向**单进程多账号**架构,理由见 §2。

## 1. 背景与问题

本地轨当前按**单用户**设计:`Session` 等表无归属字段、本地会话是扁平共享池,`CloudIdentity` 单行(`id='default'`)。实测两个云端账号登录看到同一批本地会话。目标:**一个云端账号 = 一套独立本地数据**。

## 2. 为什么选「单进程 + 共享库字段隔离」(而非物理隔离/进程池)

两个决定性的新约束:

1. **运行时热加载是独立的硬需求**:产品后续要让用户**通过 Agent 对话修改提示词 / 安装移除技能 / 配置 MCP**。这要求提示词/技能/MCP 能在**不重启进程**的前提下动态重载 —— 无论是否多账号,都得建这套热重载机制。
2. **切账号「重新加载」可接受**:用户确认切账号时重载 MCP/技能/提示词没问题,不需要并发多账号常驻。

既然热重载无论如何要建,「切账号 reload」就是顺带的;而**单库字段隔离绕开了运行时换 DataSource 的难题**(DB 连接固定不变,只改查询过滤)。物理隔离/进程池的额外价值(秒切、构造级隔离)不再值得其复杂度与内存代价。

## 3. 已确认的设计决策

- **D1 单进程**:一个常驻 server-agent,**永不为切账号重启**,固定监听 3100。web-agent 仍直连 3100,**前端连接方式不变**。
- **D2 共享 DB + 字段隔离**:一个 `~/.meshbot/agent.db`;按账号隔离的表加 `cloud_user_id`,查询按**当前活跃账号**过滤。
- **D3 进程级活跃账号**:同一时刻**一个**活跃账号(非按请求并发多租户)。切换 = 改活跃账号 + 重载配置。
- **D4 每账号文件 + 热重载**:`accounts/<cloudUserId>/{skills,prompt,mcp.json,workspace}` 按活跃账号**动态解析**;切账号 / 用户改配置都走同一套 reload(MCP 断开重连、技能/提示词缓存失效)。
- **D5 登录必须**:无匿名桶;已登录后离线仍可用(token 缓存)。
- **D6 不防偷看**:同 OS 用户能读所有账号数据;无静态加密。本设计是正确性/归属隔离。
- **D7 不迁移**:升级后从空开始(旧单用户数据因缺 `cloud_user_id` 被过滤,等同消失;文件留盘)。
- **D8 非活跃账号的 CronJob 不生效**:定时任务只在其账号为活跃账号时跑 → 无需「每作业账号上下文」,沿用全局活跃账号。

## 4. 架构概览

```
单个 server-agent 进程（:3100，永不为切账号重启）
├─ ActiveAccountContext：进程级当前 cloudUserId（持久化，重启后恢复）
├─ DB：共享 ~/.meshbot/agent.db，按账号表带 cloud_user_id，查询按活跃账号过滤
├─ 文件（按活跃账号动态解析）：accounts/<cloudUserId>/{skills,prompt,mcp.json,workspace}
└─ Reloadable 配置：MCP client / 技能 / 提示词缓存 —— 切账号或用户改配置时重载

~/.meshbot/
├── agent.db                      # 共享，字段隔离
└── accounts/<cloudUserId>/       # 仅文件型，每账号一套
    ├── skills/  prompt/  mcp.json  workspace/
```

## 5. 数据模型变更

- 给**按账号隔离的表**加 `cloud_user_id`(snake_case):`sessions` / `session_messages` / `pending_messages` / `llm_calls` / `model_configs` / `settings` / `cron_jobs`。
- `CloudIdentity` 由**单行**改为**多行**(键 = `cloudUserId`),保存各账号云端 token/镜像。
- **活跃账号指针**单独持久化(全局,不属于任何账号):用一张极小的单行表(如 `app_state(active_account)`),或一条 `cloud_user_id IS NULL` 的全局 setting。**不要**塞进按账号过滤的表。
- LangGraph checkpointer 的 `checkpoints`/`writes` 表**不加列**:thread_id(=session id)全局唯一,会话列表按 `cloud_user_id` 过滤后,他账号的 thread_id 不可达 → **传递式隔离**。
- **SQLite 迁移**(TypeORM):新增列 + 多行 CloudIdentity + app_state 表。旧单用户数据无 `cloud_user_id` → 被过滤,符合 D7「从空开始」。

## 6. 活跃账号作用域与防串数据(核心风险)

唯一真实风险是「漏过滤 → 跨账号串数据」。缓解:**集中式作用域**,不靠每个查询各自记得加 `where`。

- 一个 `ActiveAccountService` 持有当前 `cloudUserId`(登录/切换时设置;启动从 app_state 恢复)。
- 各 Entity 归属 Service 的查询统一经一个 **scoped helper**(自动注入 `cloud_user_id = active`),写入自动带上 `cloud_user_id`。
- **加一个静态围栏**(类比现有 `check:repo`):校验按账号表的查询都经过 scoped helper / 带了过滤,挡住裸 `find` / 裸 raw query。
- 写时校验:跨账号写入(active 与目标行的 cloud_user_id 不一致)直接拒绝。

## 7. 每账号文件 + 热重载机制

- `MeshbotConfigService` 拆分语义:
  - **DB 路径固定共享**(`<root>/agent.db`,不随账号变)。
  - **文件 getter 按活跃账号动态返回**:`getSkillsDir()/getPromptDir()/getMcpConfigPath()/getWorkspaceDir()` → `accounts/<activeAccount>/...`,且活跃账号变化后返回新值。
  - (v1 已合入的「全树跟随 MESHBOT_HOME」对 DB 这块回退为固定共享;`MESHBOT_HOME` 仍作为顶层 root。)
- **Reload 服务**:一个 `reloadAccountRuntime()`,做:① MCP client 断开 + 按新 `mcp.json` 重连;② 技能/提示词缓存失效(下次按新目录读)。触发点:(a) 切账号,(b) 未来「用户对话改配置」。
- MCP:`McpService` 从「onModuleInit 起一次」改为「可被 reload 重新初始化」(幂等的 teardown + init)。

## 8. 登录 / 切换 / 登出

- **登录**(renderer → 现有 `/api/auth/login`):云端鉴权 → upsert 该账号 `CloudIdentity`(多行)→ 设活跃账号 = 该 cloudUserId → `reloadAccountRuntime()` → 签发本地 JWT 返回。
- **切换**(新端点 `/api/accounts/switch {cloudUserId}`,需已登录):若该账号 `CloudIdentity` 存在 → 设活跃账号 + `reloadAccountRuntime()` → 返回(浏览器既有 JWT 仍有效,因单进程单 secret;前端切换后刷新数据视图即可)。**近乎秒切,无需重启、通常无需重新登录**。
- **登出**:清活跃账号指针 + 前端 `clearAccessToken()`。账号数据/文件留盘。
- 备注:活跃账号是**服务端全局状态**,不由 token 的 sub 决定(D3)。单用户桌面下成立;非安全边界(D6)。

## 9. CronJob(D8)

调度执行器只跑「`cloud_user_id` = 当前活跃账号」的任务;切账号后,新活跃账号的任务才参与调度。无需每作业账号上下文。

## 10. 桌面壳变更(极小)

- 仍 fork **一个** server-agent(沿用 [agent-runtime.ts](../../../apps/desktop/src/agent-runtime.ts)),`MESHBOT_HOME=~/.meshbot`。**不需要进程池、不需要反向代理**。
- 多账号逻辑全在 server-agent 内(活跃账号 + 字段过滤 + reload)。
- 渲染端:登录走现有流程;新增「账号切换」调 `/api/accounts/switch`(Plan 前端部分)。强制登录闸已由现有 [auth-guard.tsx](../../../apps/web-agent/src/components/auth-guard.tsx) 覆盖。

## 11. 本版推翻了什么

- v1 的物理隔离 / 每账号一进程 / 进程池 / 反向代理 / WS 转发 —— **全部作废**。
- 已合入的 commit `f99c344`(MeshbotConfigService 遵循 MESHBOT_HOME)**保留**,但文件 getter 将进一步改为按活跃账号动态解析(§7);DB 路径回退为固定共享。

## 12. 测试策略

- **单元**:`ActiveAccountService`(设/恢复活跃账号);scoped helper 自动过滤;`MeshbotConfigService` 文件 getter 随活跃账号变化、DB 路径固定;reload 幂等。
- **集成(server-agent,jest)**:两账号写入 → 各自 `cloud_user_id` → 切活跃账号 → 断言只看到当前账号的会话/设置/模型配置;CronJob 只跑活跃账号的。
- **围栏**:新增「按账号表查询必须 scoped」静态检查的单测。
- **热重载**:切账号后 MCP 按新 mcp.json 重连、技能列表来自新目录。

## 13. 实现阶段

1. **数据模型 + 迁移**:7 张表加 `cloud_user_id`;`CloudIdentity` 多行;`app_state(active_account)`;SQLite 迁移。
2. **活跃账号 + 集中作用域**:`ActiveAccountService` + scoped 查询封装 + 静态围栏(防漏过滤)。各归属 Service 接入。
3. **文件按账号 + 热重载**:`MeshbotConfigService` 文件 getter 账号化(DB 固定);`reloadAccountRuntime()`(MCP 重连 + 技能/提示词缓存失效);`McpService` 可重载化。
4. **登录/切换/登出**:登录设活跃 + reload;`/api/accounts/switch`;登出清活跃。
5. **前端**:账号切换入口(调 switch);登出清 token;复用现有 auth-guard。
6. **CronJob 作用域**:调度只跑活跃账号任务。

## 14. 风险

- **漏过滤串数据**:靠 §6 集中作用域 + 静态围栏兜底;是本设计的主要持续维护点。
- **后台与活跃账号耦合**:非活跃账号的后台(cron)按 D8 不跑;若将来要后台多账号并行,本架构需再扩展(每作业账号上下文)。
- **reload 正确性**:MCP teardown/reconnect 的幂等与时序需在执行期真机验证(切账号时无悬挂连接、工具列表正确刷新)。
