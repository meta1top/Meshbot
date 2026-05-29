# OTA 评论抓取 Skill 设计

> 日期：2026-05-30
> 状态：待评审

## 目标

抓取 **2 个固定酒店** 在 **4 个 OTA 平台**(猫途鹰 TripAdvisor / Trip.com / Agoda / Booking)的用户评论,归一化成统一结构、去重落库。

**形态**:一个 meshbot skill(`.meshbot/skills/ota-reviews/`),每个平台一个独立 Python 脚本,核心抓取依赖 [Scrapling](https://github.com/D4Vinci/Scrapling)。

## 范围

**Phase 1(本设计)**:
- 4 个 per-platform Python 脚本 + SKILL.md + 固定目标配置 + 统一落库
- **手动触发**:用户让 meshbot agent 跑该 skill;agent `skill_load` 读 SKILL.md → `bash` 跑脚本

**明确不做(YAGNI)**:
- ❌ FastAPI / HTTP API / job 队列 / 状态轮询 —— 规模(8 个目标)用不上
- ❌ 自动每日定时 —— 留到 Phase 2(用 agent `schedule` 工具加一条每日任务即可,代码不用动)
- ❌ 代理池接入 —— 只预留配置接口,本期裸跑

## 为什么是 skill 而不是独立服务

meshbot agent 自带运行时,三件套齐全:
- `bash.tool` —— 能执行 Python 脚本(cwd 默认 `<meshbotDir>/workspace`)
- `skill_list` / `skill_load` —— 渐进式发现/加载;skill 目录可捆绑任意文件,`skill_load` 返回 `[skill dir] <绝对路径>` 供 agent 拼接执行
- `schedule-*` —— Phase 2 可让 agent 自建每日定时

因此 skill + 捆绑脚本 + bash 执行 = 完整闭环,无需 OS cron、无需独立服务进程。

## 目录结构

```
.meshbot/skills/ota-reviews/
├── SKILL.md            # frontmatter(name/description)+ 正文(用途、平台、怎么调脚本、输出、注意事项)
├── scripts/
│   ├── common.py       # 共享:Scrapling fetcher 封装、Review schema、SQLite upsert 去重、JSON 导出、CLI 参数
│   ├── tripadvisor.py  # 每平台一个:解析酒店页 + 翻页 + 抽评论 → 统一 Review
│   ├── trip.py
│   ├── agoda.py
│   └── booking.py
├── targets.json        # 2 酒店 × 4 平台的固定 URL/ID(待填)
├── requirements.txt    # scrapling 等依赖
└── tests/
    └── fixtures/       # 各平台保存的 HTML/JSON 样本,供解析单测(不打网络)
```

## 脚本契约

每个平台脚本统一 CLI:

```
python scripts/tripadvisor.py --hotel <hotel_key> [--max-reviews N] [--lang xx] [--out json]
```

- 从 `targets.json` 按 `hotel_key` 取该平台 URL/ID
- 用 `common.py` 的 Scrapling `StealthyFetcher` 抓首页 → 翻页直到 `max-reviews` 或无更多
- 解析为统一 `Review` 列表 → upsert 落库(去重)→ 退出码 0;打印本次新增/总计
- 解析逻辑各站独立,某站选择器坏了只改对应 `.py`

## 统一数据结构(Review)

| 字段 | 说明 |
|---|---|
| `site` | tripadvisor / trip / agoda / booking |
| `hotel_key` | targets.json 里的酒店标识(跨平台同一酒店共用) |
| `hotel_name` | 平台上的酒店名 |
| `review_id` | 平台内评论唯一 ID(去重键的一半) |
| `author` | 评论者 |
| `rating` | 评分(归一到 0–5 或保留原值 + 原始量纲) |
| `title` | 标题(无则空) |
| `text` | 正文 |
| `date` | 评论日期(ISO 8601) |
| `language` | 评论语言 |
| `trip_type` | 出行类型(家庭/商务等,无则空) |
| `raw` | 原始片段(JSON,便于回溯/补抽字段) |
| `scraped_at` | 抓取时间 |

**去重键**:`(site, review_id)`,upsert 幂等。

## 存储

- **SQLite**:`<meshbotDir>/workspace/ota-reviews/reviews.db`,单表 `reviews`,`(site, review_id)` 唯一索引
- **JSON 导出**:每次跑顺带导一份 `<meshbotDir>/workspace/ota-reviews/exports/<site>-<hotel_key>-<date>.json`,便于人工查看

## 反爬策略(无代理)

默认 Scrapling `StealthyFetcher`(浏览器级 stealth),不是纯 HTTP。极度礼貌:并发 1、随机延迟、复用 session。

各站裸跑(单 IP)现实预期:

| 平台 | 预期 | 备注 |
|---|---|---|
| TripAdvisor | 较好 | 先打通此站验证全链路 |
| Trip.com | 中等 | 评论接口相对可达 |
| Agoda | 差(best-effort) | 强 bot 检测,评论走带 token JSON API |
| Booking | 差(best-effort) | Cloudflare + 行为检测 |

`common.py` 预留 `proxy` 配置项(留空),Phase 2 买住宅代理直接填,脚本不改。

## 错误处理

- 每页重试 + 指数退避
- **部分结果实时落库**:抓到一页就 upsert,中断不丢已抓数据,下次跑续抓(靠去重)
- 检测到验证码 / 403 / Cloudflare 挑战 → 该平台脚本以非 0 退出 + 打印 `BLOCKED: 需要代理`,不影响其他平台
- 单平台失败不阻断其他平台(agent 逐个跑)

## 测试

- **解析单测**:每平台用 `tests/fixtures/` 下保存的 HTML/JSON 样本测抽取逻辑,不打网络(选择器回归可测)
- `Review` schema 校验 + SQLite 去重 upsert 单测
- 真实联网 smoke test 单独、可选,不进默认测试

## 合规

- 只抓公开评论页;可配速率限制
- 低速 + 去重减少请求量;SKILL.md 注明 ToS/robots 注意事项

## 待办/开口项

- `targets.json` 需填入 2 酒店 × 4 平台的实际 URL/ID(已知其一:The Magellan Sutera Resort 的 TripAdvisor 页)
- 运行环境需有 Python 3 + 能 `pip install scrapling`(及其浏览器依赖,如 Camoufox/Playwright);SKILL.md 写明安装步骤
- Agoda/Booking 优先尝试其内部评论 JSON API(请求更少、更稳),HTML 解析作兜底
