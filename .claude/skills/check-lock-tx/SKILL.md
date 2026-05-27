---
name: check-lock-tx
description: "Run the static lock-transaction inversion fence (`pnpm check:lock-tx`) to detect the \"transaction-lock inversion\" vulnerability — situations where a `@WithLock` decorator runs inside a `@Transactional` boundary, causing the Redis lock to be released while the database transaction is still uncommitted, silently bypassing uniqueness / idempotency protection. Use when the user is about to commit changes that touch any `*.service.ts` under `libs/**` or `apps/server-*/**`, especially when adding or modifying `@Transactional()` / `@WithLock()` decorators or call chains between them, or explicitly asks to audit lock-transaction safety."
---

# Check Lock-Tx Inversion Fence

围栏脚本 `scripts/check-lock-tx.ts` 通过 AST 静态分析检测「事务-锁倒置」漏洞——`@Transactional` 在外层 / `@WithLock` 在内层导致锁的临界区 ⊊ 事务的临界区，唯一性 / 幂等保护被静默绕过（参见 `.claude/skills/service-tx-lock-cache/SKILL.md` 「严禁事务-锁倒置」章节中的漏洞机理）。

## 关键路径

| 资源 | 位置 |
| --- | --- |
| 脚本实现 | `scripts/check-lock-tx.ts` |
| 命令入口 | `pnpm check:lock-tx`（在 `package.json:scripts`） |
| 报告输出 | `docs/audits/lock-tx-fence/<YYYY-MM-DD-HHmm>.md` + `.json` |
| 配套规范 | `.claude/skills/service-tx-lock-cache/SKILL.md` 「严禁事务-锁倒置」章节 |
| 兄弟围栏 | `pnpm check:tx`、`pnpm check:naming`（事务侧三件套之一） |

> **维护原则**：脚本和本 SKILL.md 是配套的——改脚本逻辑（增减 finding 类别、调整字段类型解析、放宽豁免标记）必须同步更新本文 + cursor rule 章节。

## 何时触发

按以下场景**主动**跑 `pnpm check:lock-tx`，不要等用户开口：

1. **commit 前自检**：用户表达"准备 commit / 这次改动 OK 吗" → 全量跑一次
2. **新加 / 修改 `@Transactional()` 或 `@WithLock()` 装饰器之后** → 跑一次确认没引入倒置
3. **新加 / 重构 service 层方法体的调用链**（尤其是 `@Transactional` 方法内新增对其他 service 的调用）→ 跑
4. **跑完 `pnpm check:tx` / `pnpm check:naming` 修复完事务侧问题** → 紧接着跑一次锁-事务围栏闭环

不在以下场景跑（避免噪音）：
- 只改 controller / processor / 测试 / 文档
- 改 entity 字段但 service 方法体未变
- 改前端代码（web-agent / web-main）

## 命令清单

```bash
pnpm check:lock-tx                                         # 全仓扫描，stdout + 增量写报告（默认）
pnpm check:lock-tx -- --strict                             # 有 finding 时 exit 1（CI 用）
pnpm check:lock-tx -- --paths libs/agent                   # 仅扫指定路径，逗号分隔（局部扫描会关闭增量）
pnpm check:lock-tx -- --types LOCK_INSIDE_TX_CALL          # 仅看指定类别，逗号分隔（局部扫描会关闭增量）
pnpm check:lock-tx -- --json                               # stdout 改为 JSON
pnpm check:lock-tx -- --no-report                          # 强制不写报告（仅 stdout）
pnpm check:lock-tx -- --force-report                       # 强制写报告（无视增量判定，刷 baseline 用）
pnpm check:lock-tx -- --out-dir /tmp/x                     # 改报告目录
```

注意 `--` 分隔符：pnpm 需要 `--` 才会把后面参数透传给脚本。

执行时间 ≈ 1.5s，全仓 ts-morph AST 分析（含两次 pass：先收集 `@WithLock` 方法集合，再扫每个 `@Transactional` 方法）。

## 报告写入策略：增量

默认开启**增量模式**：
1. 找 `docs/audits/lock-tx-fence/` 下最新的 `*.json` 作为 baseline
2. 用指纹 `type|file|className.methodName|target.className.target.methodName`（**忽略行号**，但**保留被调用的 lock 方法**作为指纹一部分——同一 tx 方法可能调多个不同 lock 方法）对比当前 finding 集合
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
pnpm check:lock-tx -- --force-report
```

## 2 类 finding 与修复指引

### LOCK_INSIDE_TX_DECORATOR — 同方法装饰器顺序倒置

> 触发条件：方法上同时挂了 `@Transactional` 和 `@WithLock`，但**源码中 `@Transactional` 在 `@WithLock` 上方**。装饰器执行顺序「上 = 外层」，因此事务先开、锁后获取，构成倒置。

**修复**：直接调换两个装饰器的顺序：

```ts
// ❌ 错误
@Transactional()
@WithLock({ key: 'foo:#{0}' })
async createWithLock(id: string) { ... }

// ✅ 正确：@WithLock 必须在 @Transactional 之上
@WithLock({ key: 'foo:#{0}' })
@Transactional()
async createWithLock(id: string) { ... }
```

无例外，全部纠正。

### LOCK_INSIDE_TX_CALL — `@Transactional` 方法体内调用 `@WithLock` 方法

> 触发条件：`@Transactional` 方法的方法体内出现调用，被调用的方法本身带 `@WithLock`。涵盖两种调用形式：
>
> - **同类自调**：`this.x()`——通过同类内 `@WithLock` 方法集合直接命中
> - **跨类调用**：`this.field.x()`——通过 constructor 参数的类型注解解析 `field` 的类，再查该类的 `@WithLock` 集合

**漏洞机理**（参见 cursor rule）：锁的临界区 ⊊ 事务的临界区。当锁释放时事务还没结束，"持锁期间的写入对外不可见"——等价"持锁期间事务对外不可见的重入攻击"。

**修复决策**（按优先级）：

#### 写法 A：把锁提升到外层（覆盖整个事务）

```ts
// ✅ 锁覆盖整个事务
@WithLock({ key: 'order:create:#{0}', ttl: 10000 })
@Transactional()
async createOrder(userId: string, name: string) {
  await this.repo.save(order);
  await this.foo.createName(name);   // 内部不要再带 @WithLock
}
```

适用：调用链上只有 1 处 lock 需求，且能把同一把锁的 key 上提到外层方法的入参中。

#### 写法 B：拆方法（无锁版本 + 加锁版本）

把被调用的 `@WithLock` 方法拆成两个：

```ts
// 内部版本：无 @WithLock，可被事务方法直接调用
private async createXInDb(...) { ... }

// 公开版本：保留 @WithLock，作为独立入口供其他场景使用
@WithLock({ key: '...' })
async createX(...) {
  return this.createXInDb(...);
}

// 事务方法调内部版本，避开倒置
@Transactional()
async outerWorkflow() {
  await this.createXInDb(...);   // 不再触发锁
  // ...
}
```

适用：`@WithLock` 方法仍然要单独对外提供（其他调用方需要锁保护），只是当前 tx 链路上要避开。

#### 写法 C：把"必须在事务内"的步骤拆出去

如果调用 `@WithLock` 方法的目的就是借它做"幂等校验"，可以反过来——让外层不开事务，让内层 lock 方法各自管自己的小事务：

```ts
// ✅ 没有外层事务，两步分别保证幂等
async provisionAgent(userId, data) {
  const agent = await this.agentService.createWithLock(userId, data);  // @WithLock + 内部小事务
  await this.ensureAgentBindings(agent.id);                            // @WithLock + 幂等
  return agent;
}
```

适用：原本的"外层事务"其实并不需要——各步骤本身就是幂等可重入的（如 `ensure*` 模式）。

#### 兜底：DB 唯一索引始终保留

无论选哪种写法，**唯一性约束在数据库层加 unique index**——这是正确性保护层，锁只是性能保护层。

## 输出解读模板

跑完 `pnpm check:lock-tx` 后，按下面格式向用户汇报：

**情况 A：无新增 finding（脚本自动跳过写报告）**

```
[lock-tx-check] 共 N 个 finding（与 baseline 持平 → 未生成新报告）
  baseline: docs/audits/lock-tx-fence/<上一份>.md
  unchanged=N  removed=K  added=0
- LOCK_INSIDE_TX_DECORATOR: x
- LOCK_INSIDE_TX_CALL:      x
```

**情况 B：检测到新增 finding（脚本自动写新报告）**

```
[lock-tx-check] 共 N 个 finding（新报告：docs/audits/lock-tx-fence/<新>.md）
  vs baseline: added=M  removed=K  unchanged=U
- LOCK_INSIDE_TX_DECORATOR: x  ← 装饰器顺序错误，必修（无例外）
- LOCK_INSIDE_TX_CALL:      x  ← 调用链倒置，按 A/B/C 三种写法重构

新增 finding 列表:
  <文件>:<行>  <Tx Class>.<tx Method>  调用了  <Lock Class>.<lock Method>
```

如果 finding 数 = 0，明确告诉用户"事务-锁围栏全绿"。

## 豁免机制

三种形式（按优先级排序）：

```ts
// lock-tx-check: ignore-file (整文件豁免，慎用)
```

放在文件**首部 500 字符内**，跳过整个文件。

```ts
// lock-tx-check: ignore (本方法跳过倒置校验)
@Transactional()
async someTx() { ... }
```

放在方法**正上方的 leading 注释**，跳过该方法。

```ts
/**
 * 创建分组：内部各步骤本身已是幂等设计，外层事务允许包含锁方法
 * @allow-lock-inside-tx  各步骤幂等，无外层事务原子性需求
 */
@Transactional()
async createGroupWithProvision(...) { ... }
```

JSDoc 中含 `@allow-lock-inside-tx` 标记 —— **首选写法**，更具语义、便于检索。

> 任何豁免**必须配合一行原因注释**，避免后续无人能解释。**慎用豁免**：除非确认调用链上的步骤本身就是幂等可重入（如 `ensure*` 模式 + DB unique index 兜底），否则不要豁免——这是真正的安全漏洞。

## 与 `check:tx` / `check:naming` 围栏的关系

事务侧三个围栏覆盖不同维度，**互补不重叠**：

| 维度 | `check:tx` | `check:naming` | `check:lock-tx` |
|---|---|---|---|
| 关注 | 装饰器是否该挂 / 已挂 | 装饰器与命名是否一致 | 锁与事务边界是否倒置 |
| 检测点 | MISSING / WRONG_IMPORT / REDUNDANT / BYPASS | PRIVATE_TX_NAMING / MISSING_TX_ON_NAMED | LOCK_INSIDE_TX_DECORATOR / LOCK_INSIDE_TX_CALL |

**推荐串联跑**：

```bash
pnpm check:tx && pnpm check:naming && pnpm check:lock-tx
```

或并发：

```bash
pnpm check:tx & pnpm check:naming & pnpm check:lock-tx & wait
```

## v0 已知局限（向用户主动说明）

- **调用链只展开 1 层**：`A.tx → A.normal → B.locked` 这种 2 层间接倒置**无法检出**——仍需人审 + 自检清单兜底
- **跨类字段类型解析**：仅支持 NestJS 风格的 constructor 字段注入（`constructor(private readonly foo: FooService)`）；动态字段、工厂注入、抽象类型等解析失败时**跳过该调用**（避免误报，但可能漏报）
- 不分析 super 调用、不分析 mixin
- 文件级豁免后**整个文件零检测**，谨慎使用

如果围栏全绿但你仍不放心（如调用链很深 / 涉及动态字段），建议主动配合阅读 `.claude/skills/service-tx-lock-cache/SKILL.md` 中的「自检清单」做人工二审。

## 与 cursor rule 的关系

| 阶段 | 工具 | 角色 |
|---|---|---|
| 写代码时 | `service-tx-lock-cache` 技能「严禁事务-锁倒置」 | 让 AI / 人按规范写 |
| 写完后 | 本 skill + `pnpm check:lock-tx` | 静态围栏验证未引入倒置 |
| 配套验证 | `pnpm check:tx` + `pnpm check:naming` | 验证事务装饰器使用本身合规 |

rule 负责"少出错"，围栏负责"漏的兜回来"。

