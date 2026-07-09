# web-main 登录后前置引导门（OnboardingGate）设计

- 日期：2026-07-09
- 范围：web-main（云协同前端）登录/注册成功后，把「有组织」「组织有可用模型配置」作为进入 app 的前置门；缺失时就地引导（创建/加入组织、配置模型），都满足才放行首页。
- 不含：server-main 后端改动（组织/模型/profile 接口已具备）；web-agent；/authorize 设备授权支线的既有 org 引导。

## 1. 背景与根因

**症状**：注册/登录成功后直接进首页（`/assistant`），未走「创建/加入组织 → 配置模型」前置。

**根因（调查结论）**：前置门在 web-main 常规落地流程里**从未实现**：
- `register/page.tsx:118` / `login/page.tsx:56` → `router.replace(next ?? "/assistant")`；`(shell)/assistant/page.tsx` 是纯静态占位页，不读 profile/activeOrg/模型。
- `components/auth-guard.tsx` 只判 `profile.data.user != null`（登录与否），不看 `activeOrg`。`(shell)/layout.tsx` 明确「鉴权交给根 AuthGuard」，无二次门禁。
- 能建/加入组织的 `components/auth/org-onboarding.tsx`（`OrgOnboarding`）**只挂在 `/authorize`** 设备授权支线，未接主流程；`settings/org` 无组织时只显示 `noOrg` 静态文案（死胡同，无表单）。
- web-main **没有**任何「组织无模型 → 拦截/引导」的门（同名机制只在 web-agent `model-setup-gate.tsx`）。

**可用素材**（已存在，供复用/判断）：
- `profile`（`rest/auth.ts`）：`{ user, activeOrg: OrgSummary | null, memberships: OrgSummary[] }`；`OrgSummary` 含 `role: OrgRole`（`libs/types-main/src/org/org.types.ts`）。
- `OrgOnboarding`：创建组织（成 owner）/ 粘贴邀请码（加入）。
- `useModelConfigs(orgId)`（`rest/model-config.ts`）→ `GET /api/orgs/:orgId/model-configs`；`useCreateModelConfig(orgId)` → `POST` 同路径。
- 后端 `org-model-config.controller.ts`：模型配置 CRUD **owner 限定**。
- `settings/models/page.tsx`：模型配置自助页（含创建表单）。
- web-agent `model-setup-gate.tsx`：非配置角色的只读提示门（可参照风格，不共享代码）。

## 2. 关键决策（已确认）

| 维度 | 决策 |
|------|------|
| 门的位置 | **集中式条件渲染门**，挂 `(shell)/layout.tsx` 包住 children（只 gate 已认证 app 路由；auth 页在 (shell) 外不受影响） |
| 组织门 | 无 `activeOrg` → 复用 `OrgOnboarding`（创建/加入） |
| 模型门 | **按角色分流**：org 有模型→放行；无模型 + owner→配置表单；无模型 + 非 owner→只读拦截「请联系 owner 配置模型」 |
| 落地目标 | register/login 仍 `→ /assistant` 不变，门在 (shell) 层拦截 |

## 3. 架构与组件

### 3.1 `OnboardingGate`（新，`apps/web-main/src/components/auth/onboarding-gate.tsx`）

条件渲染门，包住 `(shell)` 的 children。AuthGuard 先保证已登录（`user != null`），Gate 在其内按序求值：

```
profile 未就绪 / loading                         → 加载态
profile.activeOrg == null                        → <OrgOnboarding/>
有 activeOrg：
  useModelConfigs(activeOrg.id) loading          → 加载态
  modelConfigs.length > 0                        → 渲染 children（进 app）
  modelConfigs.length == 0：
    activeOrg.role === "owner"                    → 模型配置步（建首个）
    else                                          → 只读拦截「请联系组织 owner 配置模型」
```

- `OrgOnboarding` / `createModelConfig` 成功各自 `invalidate` 对应 query（profile / model-configs）→ Gate 重新求值自动前进，无需手动跳转。
- query 出错 → 渲染错误态（含重试）；避免在 loading 未定时闪出 app 或错误步。

### 3.2 决策纯函数 `resolveOnboardingStep`（同文件或 `onboarding-gate.model.ts`）

把「给定状态 → 该显示哪一步」抽成零 React 依赖的纯函数，单测覆盖各组合：
```ts
type OnboardingStep = "loading" | "org" | "model-owner" | "model-blocked" | "ready";

function resolveOnboardingStep(input: {
  profileLoading: boolean;
  activeOrg: { role: OrgRole } | null;   // 传 activeOrg（含 role）或 null
  modelConfigsLoading: boolean;
  modelConfigCount: number;
}): OnboardingStep;
```
规则：`profileLoading` → `loading`；`activeOrg == null` → `org`；`modelConfigsLoading` → `loading`；`count > 0` → `ready`；`count === 0 && role === "owner"` → `model-owner`；否则 → `model-blocked`。

> 注：模型配置 owner 限定，故仅 `role === "owner"` 走配置表单；`admin`/`member` 均走只读拦截（后端不允许他们配）。

### 3.3 组织步

复用 `OrgOnboarding`（现成）。不改其内部；仅在 Gate 的 `org` 分支渲染它。

### 3.4 模型步（owner）

建首个模型配置。优先**复用 `settings/models` 的创建表单**；若其与列表/管理耦合难干净复用，则抽一个共享 `ModelConfigForm`（`useCreateModelConfig(activeOrg.id)` + 相同字段/校验），`settings/models` 与 Gate 同用（DRY）。表单走共享 Zod schema + `Form/FormItem/useSchema`（web-form-convention），label 走 `useTranslations`。

### 3.5 模型步（非 owner）

只读拦截组件：文案「组织尚未配置模型，请联系组织 owner 配置后再使用」（i18n），无表单。可提供「刷新/重试」与「切换组织」（若 `memberships` 有多个）入口，均可选、YAGNI 先做最小只读提示。

## 4. 数据流

```
AuthGuard(已登录) → OnboardingGate
  profile: useProfile()  → { user, activeOrg(role), memberships }
  models:  useModelConfigs(activeOrg.id)  （activeOrg 存在时才启用）
  resolveOnboardingStep(...) → 渲染 org / model-owner / model-blocked / loading / children
  createOrg | acceptInvite  → invalidate profile
  createModelConfig         → invalidate model-configs(orgId)
  （invalidate 后 Gate 自动重算前进）
```

`useModelConfigs` 仅在 `activeOrg != null` 时 enabled（`enabled: !!activeOrg`），避免无 org 时打无效请求。

## 5. 明确不做（YAGNI / 边界）

- 不改 register/login 落地目标（仍 `/assistant`；门在 shell 层拦截）。
- 不改 `AuthGuard` 的鉴权判定；不动 `/authorize` 设备授权支线（它自带一套 org 引导，属独立流程，本次不合并/不重构）。
- 不动 web-agent（其 `ModelSetupGate` 仅作风格参照，不共享代码）。
- 不做 admin 也能配模型（后端 owner 限定，前端遵从）；不做组织切换器增强（除非最小只读提示里顺带）。
- 不做「模型配置向导多步表单」——建一个可用配置即放行，复杂度留后续。

## 6. 测试

- **纯逻辑单测**（web-main jest，`.spec.ts`，对齐现有纯逻辑测试惯例）：`resolveOnboardingStep` 覆盖 loading / 无 org / 有 org 无模型（owner）/ 有 org 无模型（member/admin）/ 有模型 放行 各组合。
- **渲染/流转**：跑 web-main（`pnpm dev:web-main`，:3002，需 server-main 后端）眼验：新用户注册→组织步→（owner）模型步→首页；加入已配模型组织→直接首页；非 owner 加入无模型组织→只读拦截。（web-main 无 React 组件测试栈，渲染不硬造组件单测。）
- `pnpm typecheck` + 静态围栏 + i18n 对齐全绿。

## 7. 验收标准

1. 新注册用户（无 org）→ 落地即见组织引导（创建/加入），不进首页。
2. 创建组织成为 owner 后 → 见模型配置步；配成首个模型 → 进首页。
3. 粘贴邀请码加入**已有模型**的组织 → 直接进首页。
4. 非 owner 加入**无模型**组织 → 见只读「请联系 owner」拦截，不进首页、不报 403。
5. 已完成 org+模型 的老用户 → 登录后正常直达首页（门透明放行）。
6. `resolveOnboardingStep` 单测通过；typecheck / 围栏 / i18n 绿。

## 8. 风险与注意

- **加载态闪烁**：profile / model-configs 两段异步，务必在任一 loading 时统一渲染加载态，避免「先闪首页再跳组织步」或「先闪组织步」。`resolveOnboardingStep` 用 loading 优先级规避。
- **模型步表单复用**：若 `settings/models` 表单与列表强耦合，抽 `ModelConfigForm` 时别把管理页逻辑一起拖进 Gate；只要「建一个配置」的最小表单。
- **i18n**：所有新文案走 next-intl（web-main messages），禁止裸字符串（i18n-page 规范）。
- **门范围**：Gate 包 (shell) 全部路由是有意的——门本身就地提供 org/model UI，故用户即使被拦也无需能访问其它 (shell) 页。
- `/authorize` 的 org 检查与新 Gate 逻辑重复但服务不同流程，本次并存不合并（避免牵动设备授权链）。
