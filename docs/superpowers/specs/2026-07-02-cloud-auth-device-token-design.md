# 云端登录形态改造 + 配置云端化(子项目 A)设计

日期:2026-07-02
状态:已与用户确认

## 背景与总体拆解

meshbot 向「云端协同为中心、多设备 Agent 接入」的形态演进,总蓝图拆为四个子项目,各自独立走 spec → plan → 实施:

| # | 子项目 | 内容 | 依赖 |
|---|--------|------|------|
| **A(本 spec)** | 云端登录形态 + 配置云端化 | web-main 账号页面、浏览器授权登录、组织级模型配置上云下发 | 无 |
| B | 设备 Agent 注册 + 双向通道 | 设备注册表、多设备、云端可寻址某设备 Agent | A(弱) |
| C | Agent 进频道/群 | 群组概念、Agent 作为会话成员、消息路由到设备 Agent | B |
| D | 人机协同流程平台 | 流程定义/实例/节点状态机、编辑器、server-main MCP server、云端 Agent 节点 | B、C |

本 spec 只覆盖 A。A 中引入的 `device` 表与 device token 是刻意为 B 埋的地基。

## 现状(2026-07 盘点)

- 本地已无独立注册登录:server-agent `api/auth` 代理 server-main(邮箱+密码),本地存 `CloudIdentity` 镜像 + 本地 JWT。
- web-main 几乎空壳(落地页 + 云盘分享页);登录、组织管理 UI 都在 web-agent(代理云端)。
- 云端注册无邮箱验证;JWT 7 天有效,无吊销能力。
- 模型配置(`ModelConfig`)只在本地 SQLite,云端没有。
- 云端 IM(conversation/message/presence + `ws/im`)已完整,本地是薄代理;不在 A 范围。

## 目标

1. 本地登录改为「点击 → 浏览器打开云端授权页 → 授权 → 自动回传」(Claude Code Desktop 式体验),去掉本地邮箱密码表单与注册页。
2. 授权产物为**长期、可吊销的 device token**,云端有设备列表与吊销能力。
3. 注册、登录、邮箱验证、组织管理、模型配置、设备管理全部收敛到 web-main;web-agent 相应页面删除或改只读。
4. 组织级模型配置云端存储,本地登录后拉取为只读缓存,离线可用。

## 非目标(YAGNI)

- 不做标准 OAuth2/PKCE 完整协议(第一方唯一客户端,收益低);仅借用 code_verifier 防截获思想。
- 不做云端→Agent 反向指令通道(子项目 B)。
- 不做 Agent 进频道、群组概念(子项目 C)。
- 不做用户级模型配置叠加(只做组织级;后续有需要再加)。
- 不做旧 cloudToken 自动兑换 device token(存量用户重新授权一次)。

## 一、云端侧(server-main)

### 1.1 数据模型(Postgres,追加式 SQL DDL,DBA 手动执行)

- **`device`** — 已授权设备。`id`、`user_id`、`org_id`(当前激活组织)、`name`、`platform`、`token_hash`(device token 的 SHA-256,不存明文)、`last_seen_at`、`revoked_at`、`created_at`。归属 Service:新建 `DeviceService`(libs/main)。
- **`device_auth_request`** — 授权中间态。`id`、`user_code`(一次性授权码)、`code_challenge`(本地 verifier 的哈希)、`redirect_uri`(loopback 地址含实际端口)、`device_name`、`platform`、`status`(pending/approved/consumed/expired)、`user_id`(批准人)、`expires_at`(TTL 10 分钟)、兑换尝试计数。归属 Service:新建 `DeviceAuthService`。
- **`app_user` 加列** — `email_verified_at`。
- **`email_verification`** — 邮箱验证码。`email`、`code`(6 位)、`expires_at`(10 分钟)、`attempts`、重发冷却基于 `created_at`(60 秒)。归属 Service:新建 `EmailVerificationService`。
- **`org_model_config`** — 组织级模型配置。`org_id`、`name`、`provider`、`model`、`api_key`(应用层 AES-GCM 加密存储,密钥来自服务端配置/环境变量)、`base_url`、`enabled`、`is_default`。归属 Service:新建 `OrgModelConfigService`,仅 owner/admin 可写。

所有 DDL 遵循项目规范:幂等(IF NOT EXISTS)、snake_case、逻辑外键、文件不可变。

### 1.2 授权流程(loopback 回调 + 手动粘贴兜底)

1. 本地点击「登录」→ server-agent 生成 `code_verifier`,调云端 `POST /api/device-auth/start`(设备名、平台、verifier 哈希、loopback 回调地址含实际端口)→ 得 `request_id`,拼授权 URL 交前端打开浏览器。
2. 浏览器进 web-main `/authorize?request=<request_id>`:未登录先登录/注册(含邮箱验证);已登录显示「设备 XXX 请求接入你的账号」确认页。
3. 用户确认 → 云端置 `approved`、生成一次性 `user_code` → 302 到 `http://127.0.0.1:<port>/api/auth/callback?code=...`;重定向不可达(SSH/远程)时页面直接展示该码供手动粘贴。
4. 本地拿码 → `POST /api/device-auth/exchange`(`request_id` + `user_code` + `code_verifier`)→ 云端校验(状态、TTL、verifier 哈希、尝试次数)→ 创建 `device` 行、签发 device token(256 位随机不透明串,明文仅此一次下发,库存哈希)。
5. 本地存 device token 入 CloudIdentity、签本地 JWT,登录完成。

### 1.3 认证层双凭据

- 浏览器会话:沿用现有 JWT(payload `{userId, email, orgId}`)。
- Agent 设备调用(HTTP + `ws/im` 握手):`Bearer <device token>` → 按 SHA-256 查 `device` 表、校验 `revoked_at is null` → org 上下文取 `device.org_id`。
- 切组织:设备侧切组织 = 更新 `device.org_id`(替代 JWT 重签)。
- 吊销:用户在 web-main 设备管理页吊销 → 置 `revoked_at` → 该设备下一次请求 401、WS 断开。
- `last_seen_at` 低频更新(如每 5 分钟一次),避免每请求写库。

### 1.4 注册邮箱验证

注册 → 创建用户(`email_verified_at` 为空)+ 发 6 位验证码(复用现有 email 基础设施)→ 验证通过方可登录。**通过组织邀请链接注册的用户视同已验证**(邀请邮件即邮箱所有权证明)。存量用户(升级前注册)视同已验证(迁移 SQL 回填)。

## 二、本地侧(server-agent + web-agent)

### 2.1 server-agent

- 新增端点:`POST api/auth/authorize/start`(生成 verifier、调云端、返回授权 URL)、`GET api/auth/callback`(loopback 接码)、`POST api/auth/authorize/complete`(手动粘贴码)。两路殊途同归:拿码 → exchange → 存 device token → 签本地 JWT → 经 `ws/events` 推「登录完成」事件(前端无需轮询)。
- 删除:`register`/`login` 密码代理端点及 `cloud-auth.service.ts` 对应方法;`cloud-org.controller.ts` / `cloud-org.service.ts` 组织管理代理。
- `CloudIdentity` SQLite TypeORM 迁移:新增 `device_token` 列;`cloud-client.service.ts` 与 `im-relay-client.service.ts` 凭据来源切到 device token。多账号能力保留(每次授权 upsert 一条 CloudIdentity,`account-runtime.registry.ts` 机制不变)。
- 模型配置同步:登录成功时、进程启动时、定时(30 分钟)拉取 `org_model_config` → 整体替换本地 `ModelConfig` 表中云端来源行;失败静默用缓存 + 指数退避重试。本地 `ModelConfig` 表需 SQLite 迁移新增 `source` 列(`cloud` / `local`)以区分云端下发行与存量本地行,替换只作用于 `source='cloud'`。

### 2.2 web-agent UI

- 登录页:表单 → 「通过浏览器登录」按钮 + 等待授权状态 + 折叠的「手动输入授权码」降级输入框;注册页删除。
- 组织管理页删除;模型设置页改只读展示 + 「在云端管理」跳转(基于 `MESHBOT_CLOUD_URL` 环境感知拼 web-main 地址)。

## 三、web-main 页面

新增:登录 / 注册(含邮箱验证)/ `/authorize` 设备授权确认 / 组织管理(成员、邀请、切换)/ 模型配置管理(owner/admin)/ 设备管理(查看、吊销)。

全部遵循现有约定:`Form/FormItem + useSchema` 共享 Zod Schema、next-intl 国际化(禁裸字符串)、`packages/design` 组件库、Swagger 完整声明。

Schema 归属:设备授权与模型配置的 schema 本地轨也要消费(server-agent 调云端、本地缓存同步),放 `libs/types`(跨域);组织管理、邮箱验证仅云端域使用,放 `libs/types-main`。

## 四、错误处理与降级

- 授权请求 10 分钟过期;一次性码兑换限 5 次尝试;verifier 不匹配作废整个请求;失败可一键重新发起。
- device token 401 → 标记 CloudIdentity 未登录、断开该账号 IM relay → `ws/events` 推「需要重新授权」,UI 顶部提示;本地 Agent 能力不受影响。
- 离线/云端不可用:模型配置用缓存,登录态不因断网失效,同步失败仅记日志。
- 邮箱验证码:10 分钟有效、重发 60 秒冷却、错 5 次作废。

## 五、兼容与迁移

- 存量登录态:旧 `cloudToken` 弃用,已登录账号显示「需要重新授权」,重新走一次浏览器授权。
- 存量本地模型配置:云端首次下发成功之前**不清空**本地既有行,避免升级瞬间无模型可用;下发成功后整体替换。
- 存量云端用户:迁移 SQL 回填 `email_verified_at`,不影响老用户登录。

## 六、测试策略

- TDD:`DeviceService` / `DeviceAuthService` / `EmailVerificationService` / `OrgModelConfigService` / 本地授权服务与同步服务,先写失败单测。
- E2E(server-main,Postgres service 基座):授权全流程(start → approve → exchange → device token 调 API → 吊销后 401)、邮箱验证注册闭环、模型配置权限(非 admin 写被拒)。
- server-agent 必须真启动 boot 验证 DI(改了 provider 结构);最后手动冒烟完整浏览器授权闭环。
- 静态围栏 `pnpm check` 全绿。

## 七、已确认的关键决策记录

1. 授权流程:loopback 回调 + 手动粘贴兜底(非纯 device code flow、非标准 OAuth2)。
2. 凭据形态:长期可吊销 device token(非复用 7 天 JWT)。
3. 模型配置:组织级(非用户级、非叠加)。
4. 本地配置:云端真源 + 本地只读缓存(离线可用)。
5. 组织管理:迁 web-main,web-agent 删除。
6. 邮箱验证:本次一并做。
