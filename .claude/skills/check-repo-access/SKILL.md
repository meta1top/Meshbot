---
name: check-repo-access
description: "Run the static repository-access fence (`pnpm check:repo`) to verify @InjectRepository ownership and layered access before commit, or after non-trivial changes that touch any `*.entity.ts`, `*.service.ts`, `*.controller.ts`, `*.processor.ts`, `*.gateway.ts`, or `*.tool.ts` under `libs/**`. Use when the user adds a new Entity, moves an Entity between libs, changes a Service's @InjectRepository, or explicitly asks to audit repository ownership / layered service access."
---

# Check Repository Access Fence

围栏脚本 `scripts/check-repo-access.ts` 通过 AST 静态分析检测 Entity 归属与 Repository 注入的合规性。本 skill 指引何时跑、怎么跑、怎么读输出、怎么对症修复。

## 关键路径

| 资源 | 位置 |
| --- | --- |
| 脚本实现 | `scripts/check-repo-access.ts` |
| 命令入口 | `pnpm check:repo`（在 `package.json:scripts`） |
| 报告输出 | `docs/audits/repo-fence/<YYYY-MM-DD-HHmm>.md` + `.json`（增量写入） |
| 配套规范 | `.claude/skills/service-repo-access/SKILL.md` |
| 关联规范 | `.claude/skills/service-tx-lock-cache/SKILL.md`（事务/缓存/锁） |

> **维护原则**：脚本与本 SKILL.md 是配套的——改脚本逻辑（增减 finding 类别、调整白名单）必须同步更新本文。规则文档不再维护硬编码的 Entity → Service 归属表，**归属由代码本身定义，脚本反推**。

## 何时触发

按以下场景**主动**跑 `pnpm check:repo`，不要等用户开口：

1. **commit 前自检**：用户表达"准备 commit / 准备提交 / 这次改动 OK 吗" → 全量跑一次
2. **新增 Entity** 后 → 跑一次确认归属正确（`-- --map` 看到该 Entity 出现且只有 1 个归属 Service）
3. **新增 / 修改 `@InjectRepository(X)`** 后 → 跑一次确认未引入 `DUP_OWNER`
4. **跨模块抽取 / 移动 Entity 或 Service** → 跑一次确认未引入 `CROSS_LIB_INJECT`
5. **新增 Controller / Processor / Gateway / Resolver / Tool** 后 → 跑一次确认未直接注入 Repository
6. **用户怀疑分层架构被破坏**（出现一个查询逻辑被多处复制、跨模块直接读表等线索）→ 跑

不在以下场景跑（避免噪音）：
- 只改前端代码（`apps/web-*`）
- 只改测试 / 文档 / 迁移 SQL
- 只改 service 方法体内部实现（不动构造器和装饰器）

## 命令清单

```bash
pnpm check:repo                              # 全仓扫描（默认 libs/**），stdout + 增量写报告
pnpm check:repo -- --strict                  # 有 finding 时 exit 1（CI 用）
pnpm check:repo -- --map                     # 仅打印 Entity → Service 归属映射，不写报告
pnpm check:repo -- --paths libs/agent        # 仅扫指定路径，逗号分隔（局部扫描会关闭增量）
pnpm check:repo -- --types DUP_OWNER         # 仅看指定类别，逗号分隔（局部扫描会关闭增量）
pnpm check:repo -- --json                    # stdout 改为 JSON
pnpm check:repo -- --no-report               # 强制不写报告（仅 stdout）
pnpm check:repo -- --force-report            # 强制写报告（无视增量判定，刷 baseline 用）
pnpm check:repo -- --out-dir /tmp/x          # 改报告目录（实验或临时位置）
```

注意 `--` 分隔符：pnpm 需要 `--` 才会把后面参数透传给脚本。

执行时间 ≈ 1s，全仓 ts-morph AST 分析。**不要因为"应该很快"就跳过**，养成跑的习惯。

## 报告写入策略：增量

默认开启**增量模式**：

1. 找 `docs/audits/repo-fence/` 下最新的 `*.json` 作为 baseline
2. 用指纹 `type|entity|file|className`（**忽略行号**）对比当前 finding 集合
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
pnpm check:repo -- --force-report
```

报告写入 `docs/audits/repo-fence/<YYYY-MM-DD-HHmm>.md` + `.json`，进 git，作为审计证据。同分钟内多次运行后写者覆盖前写者。

## 与 `--map` 的配合

`--map` 不是合规检查，而是**当前真实归属的可视化**：

```bash
pnpm check:repo -- --map
```

输出形如：

```
[repo-check v0] Entity → Service 归属映射 (共 N 个 Entity)
────────────────────────────────────────────────────────────
Entity                      归属 Service                lib
────────────────────────────────────────────────────────────
AppUser                     UserService                main
ModelConfig                 ModelConfigService         <unknown>
Setting                     SettingService             <unknown>
...

# 若出现 DUP_OWNER 违规：
ExampleEntity               ⚠ 2 个归属:                  main
                              - ExampleAService (libs/main/src/...)
                              - ExampleBService (libs/main/src/...)
```

`⚠` 标记意味着该 Entity 存在 `DUP_OWNER` 违规。新增 Entity 后跑 `--map` 立即可看到归属是否唯一、所属 lib 是否正确。

## 3 类 finding 与修复指引

### NON_SERVICE_INJECT — Controller/Processor/Gateway/Resolver/Tool 注入了 Repository

> 触发条件：`@InjectRepository(X)` 出现在以下任一类：
> - 类装饰器是 `@Controller` / `@Processor` / `@WebSocketGateway` / `@Resolver` 之一
> - 文件名匹配 `*.controller.ts` / `*.processor.ts` / `*.gateway.ts` / `*.resolver.ts` / `*.tool.ts`

**根因**：违反分层架构，跳过了 Service 层（缓存 / 锁 / 事务在 Service 上生效）。

**修复决策**：

- 该 Entity 已有归属 Service（`pnpm check:repo -- --map` 可查）→ 注入对应 Service，把数据访问逻辑搬到 Service 的公开方法里
- 该 Entity 没有归属 Service（场景罕见，通常因为是新建 Entity）→ 先建归属 Service，再让 Controller/Processor 注入 Service
- **无例外**：基础设施豁免必须在 `INFRA_WHITELIST` 中显式登记，并在 `service-repo-access.mdc` 同步说明

### CROSS_LIB_INJECT — Service 跨 lib 注入其他模块的 Entity Repository

> 触发条件：Service 文件位于 `libs/<libA>/`，其 `@InjectRepository(X)` 中的 X 定义在 `libs/<libB>/`，且 libA ≠ libB。

**根因**：违反业务域边界，绕过了对方域的归属 Service，破坏跨模块封装。

**修复**：

- 注入对方域的归属 Service（用 `--map` 查归属），通过其公开方法访问数据
- 如果对方域的归属 Service 没有合适方法 → **在对方域的 Service 上加方法**，然后注入它
- 不要"为了方便"在自己域内注入对方 Repo，会让两个 lib 的 Module 互相耦合到 Entity 层

### DUP_OWNER — 同一 Entity 在多个 Service 中被 @InjectRepository

> 触发条件：同一个 EntityName 出现在 ≥ 2 个 Service 类的 `@InjectRepository(...)` 中。

**根因**：违反"唯一归属"原则。多归属意味着同一张表的查询/写入逻辑可能在 N 处分别实现，缓存清除、事务边界、并发锁都难以统一。

**修复决策**：

- 找到**真正的归属 Service**（命名最贴近 Entity 的、或子域语义最匹配的）
- 把其他 Service 中对该 Entity Repo 的所有调用，**搬到归属 Service** 暴露成公开方法
- 其他 Service 改为注入归属 Service，调用其方法
- 删除其他 Service 中的 `@InjectRepository(X)` 与 Repo 字段

### 历史代码债（baseline）

meshbot 当前没有 `DUP_OWNER` 存量（参见 `docs/audits/repo-fence/<最新>.md`）。

处理原则（一旦未来出现存量违规）：

- 新代码**不得**引入新增违规（CI 用 `--strict` 阻断；增量模式确保新增 finding 触发新报告，便于代码审查时一眼看出）
- 存量按业务节奏分批治理，**不要在不相关的 PR 里顺手改**（影响面大）
- 大型治理建议单独立项，配合单元测试验证
- 修复一批后跑 `pnpm check:repo -- --force-report` 刷新一次 baseline，让"已修复"反映到审计快照

## 输出解读模板

跑完 `pnpm check:repo` 后，按下面格式向用户汇报：

**情况 A：无新增 finding（脚本自动跳过写报告）**

```
[repo-check] 共 N 个 finding（与 baseline 持平 → 未生成新报告）
  baseline: docs/audits/repo-fence/<上一份>.md
  unchanged=N  removed=K  added=0
- NON_SERVICE_INJECT: x
- CROSS_LIB_INJECT:   x
- DUP_OWNER:          x
```

**情况 B：检测到新增 finding（脚本自动写新报告）**

```
[repo-check] 共 N 个 finding（新报告：docs/audits/repo-fence/<新>.md）
  vs baseline: added=M  removed=K  unchanged=U
- NON_SERVICE_INJECT: x  ← 必修（违反分层）
- CROSS_LIB_INJECT:   x  ← 必修（违反域边界）
- DUP_OWNER:          x  ← 必修（违反唯一归属）

新增 finding 列表:
  <文件>:<行>  <ClassName>  [类别]  <要点>
```

如果 finding 数 = 0，明确告诉用户"Repo 访问围栏全绿"。

**手动对比上一份报告**（极少需要，因为脚本已自动比对）：

```bash
ls -t docs/audits/repo-fence/*.json | head -2
diff <(jq -r '.issues[] | "\(.type)|\(.entity)|\(.file)|\(.className)"' <prev>.json | sort) \
     <(jq -r '.issues[] | "\(.type)|\(.entity)|\(.file)|\(.className)"' <curr>.json | sort)
```

## 豁免机制

### 文件级豁免

```ts
// repo-check: ignore-file (说明原因，例如：底层适配器需直接持有多个 Repo)
```

放在文件**首部 500 字符内**，跳过整个文件。

### 基础设施白名单（INFRA_WHITELIST）

某些底层基础设施被允许直接注入或通过 DataSource 访问 Repository（事务体系自身、Store 抽象等）。**修改白名单需要同步两处**：

1. `scripts/check-repo-access.ts` 的 `INFRA_WHITELIST` 集合中加路径
2. `.claude/skills/service-repo-access/SKILL.md` 的"基础设施豁免"小节同步登记

当前白名单：

- `libs/common/src/typeorm/tx-typeorm.module.ts`
- `libs/common/src/decorators/transactional.decorator.ts`

新增白名单需要给用户**清晰理由**——基础设施豁免不是"图方便"的逃生口。

## v0 已知局限（向用户主动说明）

围栏不是全知全能，**不要给用户"过了 = 完全安全"的错觉**：

- 仅识别 `@InjectRepository(EntityName)` 字面量；通过工厂、`useFactory`、`getRepositoryToken()` 间接注入的不会被识别
- "归属"按 `@InjectRepository` 出现位置反推，没有从命名约定校验"`FooEntity` 必须归 `FooService`"
- `CROSS_LIB_INJECT` 仅按 `libs/<top-domain>/` 的第一段判定，子域内无 lib 边界（例如 `libs/agent` 内 `account/` 与 `channel/` 子域之间不算跨 lib）
- 不检测 Service 之间的"绕过归属 Service 直接 query repo 的同 Entity 读取"（需配合代码审查）
- 不检测 Repository 是否真的来自 `TxTypeOrmModule.forFeature` 注册——这是 `pnpm check:tx` 的职责

如果 finding 都过了但你（或用户）仍不放心，建议主动配合阅读 `.claude/skills/service-repo-access/SKILL.md` 做人工二审。

## 与 cursor rule 的关系

| 阶段 | 工具 | 角色 |
|---|---|---|
| 写代码时 | `service-repo-access.mdc`、`service-tx-lock-cache.mdc` | 让 AI / 人按规范写 |
| 写完后 | 本 skill + `pnpm check:repo` | 静态围栏验证产出是否合规 |
| 找归属时 | `pnpm check:repo -- --map` | 取代过去的硬编码归属表 |
| 联动检查 | `check-transactional` skill + `pnpm check:tx` | 事务装饰器合规性 |

两者上下游互补：rule 负责"少出错"，围栏负责"漏的兜回来"，`--map` 负责"取代手工维护表"。

