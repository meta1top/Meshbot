---
name: check-transactional
description: "Run the static transactional fence (`pnpm check:tx`) to verify @Transactional() usage before commit, or after non-trivial changes in service-layer code. Use when the user is about to commit changes that touch any `*.service.ts` under `libs/**` or `apps/server-*/**`, or explicitly asks to audit transactional integrity / find missing or redundant @Transactional() decorators."
---

# Check Transactional Fence

围栏脚本 `scripts/check-transactional.ts` 通过 AST 静态分析检测 `@Transactional()` 装饰器的使用合规性。本 skill 指引何时跑、怎么跑、怎么读输出、怎么对症修复。

## 关键路径

| 资源 | 位置 |
| --- | --- |
| 脚本实现 | `scripts/check-transactional.ts` |
| 命令入口 | `pnpm check:tx`（在 `package.json:scripts`） |
| 报告输出 | `docs/audits/tx-fence/<YYYY-MM-DD-HHmm>.md` + `.json` |
| 配套规范 | `.claude/skills/service-tx-lock-cache/SKILL.md` |

> **维护原则**：脚本和本 SKILL.md 是配套的——改脚本逻辑（增减 finding 类别、调整白名单）必须同步更新本文。

## 何时触发

按以下场景**主动**跑 `pnpm check:tx`，不要等用户开口：

1. **commit 前自检**：用户表达"准备 commit / 准备提交 / 这次改动 OK 吗" → 全量跑一次
2. **加 / 删 / 改 `@Transactional()` 之后** → 跑一次确认没改坏
3. **改完 service 层多处写动作的方法** → 跑一次确认装饰器还配套
4. **用户怀疑事务问题**（出现 race condition、半成品状态、外部账号孤儿等线索）→ 跑

不在以下场景跑（避免噪音）：
- 只改 controller / processor / 测试 / 文档
- 改 entity 字段但 service 方法体未变
- 改前端代码（web-agent / web-main）

## 命令清单

```bash
pnpm check:tx                              # 全仓扫描，stdout + 增量写报告（默认）
pnpm check:tx -- --strict                  # 有 finding 时 exit 1（CI 用）
pnpm check:tx -- --paths libs/agent        # 仅扫指定路径，逗号分隔（局部扫描会关闭增量）
pnpm check:tx -- --types MISSING,REDUNDANT # 仅看指定类别，逗号分隔（局部扫描会关闭增量）
pnpm check:tx -- --json                    # stdout 改为 JSON
pnpm check:tx -- --no-report               # 强制不写报告（仅 stdout）
pnpm check:tx -- --force-report            # 强制写报告（无视增量判定，刷 baseline 用）
pnpm check:tx -- --out-dir /tmp/x          # 改报告目录（实验或临时位置）
```

注意 `--` 分隔符：pnpm 需要 `--` 才会把后面参数透传给脚本。

执行时间 ≈ 1.5s，全仓 ts-morph AST 分析。**不要因为"应该很快"就跳过**，养成跑的习惯。

## 报告写入策略：增量

默认开启**增量模式**：
1. 找 `docs/audits/tx-fence/` 下最新的 `*.json` 作为 baseline
2. 用指纹 `type|subtype|file|className.methodName`（**忽略行号**）对比当前 finding 集合
3. 仅当出现【新增 finding】时才写新的 `<YYYY-MM-DD-HHmm>.md` + `.json`
4. 没有新增（finding 完全持平 / 仅减少）→ stdout 提示"无新增 finding，跳过写入"，不创建新文件

stdout 会清晰区分四种状态：
- `增量判定: 无新增 finding，跳过写入报告`（含 unchanged/removed/added 计数）
- `增量判定: 检测到新增 finding，写入新报告`
- `增量判定: 未找到 baseline，写入首份报告`（首次或 outDir 被清空后）
- `局部扫描（启用了 --paths/--types），跳过增量判定，直接写报告`

### 何时手动刷新 baseline

少数情况需要重写一份"无新增"的 baseline 报告：
- 修复了若干 finding，希望让新报告反映"已减少"作为审计快照
- 文件命名 / 行号迁移过多，想让 baseline 重新对齐当前代码

```bash
pnpm check:tx -- --force-report
```

报告写入两个文件 `docs/audits/tx-fence/<YYYY-MM-DD-HHmm>.md` + `.json`，进 git，作为审计证据。同分钟内多次运行后写者覆盖前写者。

## 4 类 finding 与修复指引

### MISSING — 多处写动作但未挂 `@Transactional()`

> 触发条件：方法体内识别到 ≥ 2 处写动作（本地 `*Repo.save/update/...` 或子 service 的 `create*/update*/revoke*/...` 调用），但方法上**没有** `@Transactional()`。

**修复决策**：

- 写动作之间**有强一致性要求**（其中一个失败必须回滚另一个）→ 加 `@Transactional()` 装饰器，并保证 import 自 `@meshbot/common`
- 写动作之间**只是顺序无关的副作用**（一个失败另一个保留也可以）→ 在方法上方加注释 `// tx-check: ignore` 豁免，注释里说明原因
- 其中一个"写动作"实际是**外部 IO**（HTTP / MQ / Redis publish）→ 不能放进事务（参照 `.claude/skills/service-tx-lock-cache/SKILL.md`），重构为先做 IO 再开事务，或反之

### WRONG_IMPORT — `@Transactional` 来源不是 `@meshbot/common`

> 项目内**唯一合法**的 `@Transactional` 实现来自 `@meshbot/common`，配合 `TxTypeOrmModule` 的 Repository Proxy 才能让事务真实生效。其他来源（如 `typeorm-transactional`）会装饰失效，事务名存实亡。

**修复**：把 import 改为：

```ts
import { Transactional } from "@meshbot/common";
```

无例外，全部纠正。

### REDUNDANT — 挂了装饰器但写动作 ≤ 1

> 单个写动作不需要事务（数据库语句本身就是原子的），装饰器纯粹是开销和误导。

**修复决策**：

- 方法确实只有 1 处写 → 删 `@Transactional()`
- 实际有多处写但脚本没识别出来（动词不在白名单 / 调用了 dataSource 直写）→ 用 `// tx-check: ignore` 豁免并加注释，或考虑把动词加入 `SUB_SERVICE_WRITE_VERB_PREFIXES`
- 方法是"开关位"，将来要扩成多写但当前只 1 处 → 用 `// tx-check: ignore` 豁免并注明"预留事务边界"

### BYPASS — 绕过 TxTypeOrmModule Proxy

> 5 种子类型都意味着代码使用了 `dataSource` 的某种入口，跳过了 Repository Proxy，因此**不会被外层 `@Transactional()` 包进同一个事务**。这是事务体系的最大隐患。

| subtype | 含义 | 处理建议 |
|---|---|---|
| `TX_NESTED` | `dataSource.transaction(...)` 内嵌事务 | 改用外层 `@Transactional()`；若必须独立事务，加豁免并写明原因（如审计日志必须独立提交） |
| `QUERY_RUNNER` | `dataSource.createQueryRunner()` | 同上，优先重构；底层基础设施可豁免 |
| `MANAGER_WRITE` | `dataSource.manager.<save\|update\|...>(...)` | 改用 `@InjectRepository` 注入仓储 |
| `GET_REPOSITORY` | `dataSource.getRepository(...)` | 改用 `@InjectRepository` 注入 |
| `RAW_SQL_WRITE` | `dataSource.query("UPDATE/INSERT/...")` | 评估是否能用 Repository API 替代；性能敏感批量操作可豁免，但必须文档化 |

**特殊背景**：基础设施层（如使用独立 connection 的本地 SQLite 模块）若作为"事务孤岛"使用 raw SQL 与独立事务，是已知设计选择，处理时**不要试图机械地"修复"它们**——询问用户是否豁免该目录或单独立项重构。

## 输出解读模板

跑完 `pnpm check:tx` 后，按下面格式向用户汇报：

**情况 A：无新增 finding（脚本自动跳过写报告）**

```
[tx-check] 共 N 个 finding（与 baseline 持平 → 未生成新报告）
  baseline: docs/audits/tx-fence/<上一份>.md
  unchanged=N  removed=K  added=0
- WRONG_IMPORT: x
- MISSING:      x
- REDUNDANT:    x
- BYPASS:       x
```

**情况 B：检测到新增 finding（脚本自动写新报告）**

```
[tx-check] 共 N 个 finding（新报告：docs/audits/tx-fence/<新>.md）
  vs baseline: added=M  removed=K  unchanged=U
- WRONG_IMPORT: x  ← 必修
- MISSING:      x  ← 按写动作语义判断
- REDUNDANT:    x  ← 按写动作真实数判断
- BYPASS:       x  ← 多数需重构或豁免

新增 finding 列表:
  <文件>:<行>  <ClassName>.<methodName>  [类别]  <要点>
```

如果 finding 数 = 0，明确告诉用户"事务围栏全绿"。

**手动对比上一份报告**（极少需要，因为脚本已自动比对）：

```bash
ls -t docs/audits/tx-fence/*.json | head -2
diff <(jq -r '.issues[] | "\(.type)|\(.subtype // "-")|\(.file)|\(.className).\(.methodName)"' <prev>.json | sort) \
     <(jq -r '.issues[] | "\(.type)|\(.subtype // "-")|\(.file)|\(.className).\(.methodName)"' <curr>.json | sort)
```

## 豁免机制

两种粒度，**必须**与一行原因注释配合，避免后续无人能解释：

```ts
// tx-check: ignore-file (基础设施层独立 connection 的事务孤岛)
```

放在文件**首部 500 字符内**，跳过整个文件。

```ts
// tx-check: ignore (DDD 聚合根边界，外部 IO 必须先于本地 commit)
@Transactional()
async create(...) { ... }
```

放在方法**正上方的 leading 注释**，跳过该方法。

## v0 已知局限（向用户主动说明）

围栏不是全知全能，**不要给用户"过了 = 完全安全"的错觉**：

- 仅靠**命名约定**（`*Repo` 后缀、`*Service` 后缀、动词前缀白名单）识别写动作，没有读 type info
- 跨 service 写**仅展开 1 层**：`A.foo()` 调 `B.bar()` 调 `C.create()`，C 的写在 A 看不到
- 不检测"事务内调外部 IO"（DANGEROUS 类）—— 这类问题靠人审 + cursor rule
- 文件级豁免后**整个文件零检测**，谨慎使用

如果 finding 都过了但你（或用户）仍不放心，建议主动配合阅读 `.claude/skills/service-tx-lock-cache/SKILL.md` 做人工二审。

## 与 cursor rule 的关系

| 阶段 | 工具 | 角色 |
|---|---|---|
| 写代码时 | `service-tx-lock-cache.mdc`、`service-repo-access.mdc` | 让 AI / 人按规范写 |
| 写完后 | 本 skill + `pnpm check:tx` | 静态围栏验证产出是否合规 |
| 重构验证 | 同上 + 单元测试 | 双保险 |

两者上下游互补：rule 负责"少出错"，围栏负责"漏的兜回来"。

