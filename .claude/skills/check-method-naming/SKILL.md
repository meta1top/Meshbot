---
name: check-method-naming
description: "Run the static method-naming fence (`pnpm check:naming`) to verify that service-layer transactional method names match the project naming convention (suffix `*InDb` / `*InTx` / `*InTransaction`, or prefix `persist[A-Z]*`) and stay in sync with `@Transactional()` decorators. Use when the user is about to commit changes that touch any `*.service.ts` under `libs/**` or `apps/server-*/**`, or explicitly asks to audit transactional naming consistency / find privately-typed transactional methods that violate the naming convention."
---

# Check Method Naming Fence

围栏脚本 `scripts/check-method-naming.ts` 通过 AST 静态分析检测 **Service 层"事务方法命名"与 `@Transactional()` 装饰器**是否双向一致。本 skill 指引何时跑、怎么跑、怎么读输出、怎么对症修复。

## 关键路径

| 资源 | 位置 |
| --- | --- |
| 脚本实现 | `scripts/check-method-naming.ts` |
| 命令入口 | `pnpm check:naming`（在 `package.json:scripts`） |
| 报告输出 | `docs/audits/method-naming/<YYYY-MM-DD-HHmm>.md` + `.json` |
| 配套规范 | `.claude/skills/service-tx-lock-cache/SKILL.md` 「事务方法命名约定」章节 |
| 兄弟围栏 | `pnpm check:tx`（事务装饰器是否合规） |

> **维护原则**：脚本和本 SKILL.md 是配套的——改脚本逻辑（增减 finding 类别、调整命名正则、放宽豁免标记）必须同步更新本文 + cursor rule 章节。

## 命名约定

private `@Transactional()` 方法必须命中以下任一形式：

| 类型 | 形式 | 推荐场景 | 示例 |
|---|---|---|---|
| 后缀（首选） | `*InDb` | 把"业务方法"中的 DB 写入步骤抽出 | `createTaskInDb`、`createOnceInDb` |
| 后缀 | `*InTx` | 同上，强调"在事务内" | `createOrderInTx` |
| 后缀 | `*InTransaction` | 同上，全称 | `softDeleteInTransaction` |
| 前缀 | `persist[A-Z]*` | 跨多个子领域聚合落库 | `persistTenantWithOwner` |

**双向规则**：
1. 私有 `@Transactional()` 方法 → 必须命中
2. 命中以上之一的私有/受保护方法 → 必须挂 `@Transactional()`

> 反向规则**只检私有/受保护方法**，public 方法不强制（公开 API 命名往往受外部使用习惯约束）。

## 何时触发

按以下场景**主动**跑 `pnpm check:naming`，不要等用户开口：

1. **commit 前自检**：用户表达"准备 commit / 这次改动 OK 吗" → 全量跑一次
2. **新加 / 重构 `@Transactional()` 方法之后** → 跑一次确认命名一致
3. **重命名 service 层私有方法之后** → 跑一次确认装饰器没漏挂
4. **跑完 `pnpm check:tx` 修复完事务问题** → 紧接着跑一次命名围栏闭环

不在以下场景跑（避免噪音）：
- 只改 controller / processor / 测试 / 文档
- 改 entity 字段但 service 方法体未变
- 改前端代码（web-agent / web-main）

## 命令清单

```bash
pnpm check:naming                                    # 全仓扫描，stdout + 增量写报告（默认）
pnpm check:naming -- --strict                        # 有 finding 时 exit 1（CI 用）
pnpm check:naming -- --paths libs/agent              # 仅扫指定路径，逗号分隔（局部扫描会关闭增量）
pnpm check:naming -- --types PRIVATE_TX_NAMING      # 仅看指定类别，逗号分隔（局部扫描会关闭增量）
pnpm check:naming -- --json                          # stdout 改为 JSON
pnpm check:naming -- --no-report                     # 强制不写报告（仅 stdout）
pnpm check:naming -- --force-report                  # 强制写报告（无视增量判定，刷 baseline 用）
pnpm check:naming -- --out-dir /tmp/x                # 改报告目录
```

注意 `--` 分隔符：pnpm 需要 `--` 才会把后面参数透传给脚本。

执行时间 ≈ 1.5s，全仓 ts-morph AST 分析。

## 报告写入策略：增量

默认开启**增量模式**：
1. 找 `docs/audits/method-naming/` 下最新的 `*.json` 作为 baseline
2. 用指纹 `type|file|className.methodName`（**忽略行号**）对比当前 finding 集合
3. 仅当出现【新增 finding】时才写新的 `<YYYY-MM-DD-HHmm>.md` + `.json`
4. 没有新增 → stdout 提示"无新增 finding，跳过写入"，不创建新文件

stdout 会清晰区分四种状态：
- `增量判定: 无新增 finding，跳过写入报告`（含 unchanged/removed/added 计数）
- `增量判定: 检测到新增 finding，写入新报告`
- `增量判定: 未找到 baseline，写入首份报告`
- `局部扫描（启用了 --paths/--types），跳过增量判定，直接写报告`

### 何时手动刷新 baseline

- 修复了若干 finding，希望让新报告反映"已减少"作为审计快照
- 文件命名 / 行号迁移过多，想让 baseline 重新对齐当前代码

```bash
pnpm check:naming -- --force-report
```

## 2 类 finding 与修复指引

### PRIVATE_TX_NAMING — 私有 `@Transactional()` 方法命名不规范

> 触发条件：方法是 `private` 或 `protected`，挂了 `@Transactional()`，但方法名既不在 `*InDb / *InTx / *InTransaction` 后缀，也不在 `persist[A-Z]*` 前缀范围内。

**修复决策**：

- **常规情况**：把方法重命名为 `*InDb`（首选），如 `removeSession` → `removeSessionInDb`、`doCreateUser` → `createUserInDb`
- 已有外部调用方较多，重命名成本高 → 评估是否能把 `@Transactional()` 挪到调用方（多数情况下事务边界应该在更上层）
- 方法体内**确实不需要事务**（如只有单 SQL 写）→ 删 `@Transactional()`；同时也跑 `pnpm check:tx` 看是否触发 `REDUNDANT`

### MISSING_TX_ON_NAMED — 命名命中约定但未挂 `@Transactional()`

> 触发条件：私有/受保护方法名命中 `*InDb / *InTx / *InTransaction` 后缀或 `persist[A-Z]*` 前缀，但方法上**没有** `@Transactional()`。

**修复决策**：

- 方法体内**确实有多处写动作**且需要原子性 → 加 `@Transactional()`
- 方法只是**单 SQL 写或纯外部 IO**，命名带 `persist*` / `*InDb` 是误导 → 重命名（`updateXxx` / `saveXxxAndCache` 等）
- 方法体内含 **HTTP / MQ 调用**故意不能放事务（如 embedding RPC + 落库）→ 在 JSDoc 中加 `@no-tx-naming` 标记豁免

## 输出解读模板

跑完 `pnpm check:naming` 后，按下面格式向用户汇报：

**情况 A：无新增 finding（脚本自动跳过写报告）**

```
[naming-check] 共 N 个 finding（与 baseline 持平 → 未生成新报告）
  baseline: docs/audits/method-naming/<上一份>.md
  unchanged=N  removed=K  added=0
- PRIVATE_TX_NAMING:   x
- MISSING_TX_ON_NAMED: x
```

**情况 B：检测到新增 finding（脚本自动写新报告）**

```
[naming-check] 共 N 个 finding（新报告：docs/audits/method-naming/<新>.md）
  vs baseline: added=M  removed=K  unchanged=U
- PRIVATE_TX_NAMING:   x  ← 私有事务方法命名不规范，建议重命名为 *InDb
- MISSING_TX_ON_NAMED: x  ← 命名暗示有事务但缺装饰器，按写动作语义判断

新增 finding 列表:
  <文件>:<行>  [private] <ClassName>.<methodName>  [类别]  <要点>
```

如果 finding 数 = 0，明确告诉用户"命名围栏全绿"。

## 豁免机制

三种形式（按优先级排序）：

```ts
// naming-check: ignore-file (整文件豁免，慎用)
```

放在文件**首部 500 字符内**，跳过整个文件。

```ts
// naming-check: ignore (本方法跳过命名校验)
@Transactional()
private async doSomething() { ... }
```

放在方法**正上方的 leading 注释**，跳过该方法。

```ts
/**
 * 记忆提取批量落库（含 embedding HTTP，故意不放事务）
 * @no-tx-naming  HTTP 调用不能在事务内
 */
async persistExtractedBatch(...) { ... }
```

JSDoc 中含 `@no-tx-naming` 标记 —— **首选写法**，更具语义、便于检索。

> 任何豁免**必须配合一行原因注释**，避免后续无人能解释。

## 与 `check-transactional` 围栏的关系

两个围栏覆盖事务方法的不同维度，**互补不重叠**：

| 维度 | `check:tx` | `check:naming` |
|---|---|---|
| 关注 | 装饰器是否该挂 / 已挂 | 装饰器与命名是否一致 |
| 检 MISSING | 多处写动作但缺 `@Transactional()` | 命名命中但缺 `@Transactional()` |
| 检 REDUNDANT | 挂了装饰器但写动作 ≤ 1 | — |
| 检 BYPASS | 绕过 TxTypeOrmModule Proxy | — |
| 检 PRIVATE_TX_NAMING | — | 私有事务方法命名不规范 |
| 检 WRONG_IMPORT | `@Transactional` 来源不合法 | — |

**推荐串联跑**：

```bash
pnpm check:tx && pnpm check:naming
```

或并发：

```bash
pnpm check:tx & pnpm check:naming & wait
```

## v0 已知局限（向用户主动说明）

- 仅检查私有/受保护方法的命名一致性，**public 方法不强制**——公开 API 命名通常已受外部使用约束
- 仅靠**正则匹配**方法名，不读 type info
- 不检测"命名相似但语义不同"的情况（如 `persistsLayout` 这种英文动词巧合，需人审）
- 文件级豁免后**整个文件零检测**，谨慎使用

## 与 cursor rule 的关系

| 阶段 | 工具 | 角色 |
|---|---|---|
| 写代码时 | `service-tx-lock-cache.mdc` 「事务方法命名约定」 | 让 AI / 人按规范命名 |
| 写完后 | 本 skill + `pnpm check:naming` | 静态围栏验证命名与装饰器是否一致 |
| 配套验证 | `pnpm check:tx` | 验证装饰器使用本身是否合规 |

rule 负责"少出错"，围栏负责"漏的兜回来"。

