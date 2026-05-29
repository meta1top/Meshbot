# OTA 评论抓取 Skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一个 meshbot skill（`tools/ota-reviews/`），每个 OTA 平台一个 Python 脚本，用 Scrapling 抓 2 个固定酒店的评论，归一化后去重落库；由 meshbot agent 手动触发。

**Architecture:** 共享模块 `common.py` 提供 Review 数据模型、SQLite 去重存储、JSON 导出、CLI 编排与 Scrapling fetch 封装；4 个平台脚本各自只实现「抓取 + 翻页 + 解析」。每个平台用「先抓真实页面存成 fixture → 对 fixture 做 TDD 解析」的方式开发，避免凭空猜选择器。SKILL.md 指导 agent 如何安装依赖、跑哪个脚本、结果在哪。

**Tech Stack:** Python 3.10、Scrapling（stealth 抓取）、Pydantic v2（schema）、stdlib sqlite3（存储）、pytest（测试）。

> **关键约定（贯穿全程）**
> - 所有路径相对仓库根 `/Users/grant/Meta1/meshbot`。
> - **源码（version-controlled）目录 = `tools/ota-reviews/`，下称 `<SKILL>`**。`.meshbot/` 是 gitignored 的运行目录，不放源码。
> - **部署**：运行时 meshbot agent 从 `<meshbotDir>/skills/<name>/SKILL.md` 发现 skill。Task 15.5 用符号链接 `.meshbot/skills/ota-reviews -> ../../tools/ota-reviews` 把源码挂过去（无拷贝、无漂移）。开发期一律在 `tools/ota-reviews/` 内操作。
> - 分支：在 `main` 上逐任务提交（用户已确认）。
> - 运行时落库根 = `<meshbotDir>/workspace/ota-reviews/`；开发期用临时目录，不写真实 workspace。
> - Python 包从 `<SKILL>/scripts/` 内以模块方式跑：`cd <SKILL>/scripts && python tripadvisor.py ...`；测试 `cd <SKILL> && pytest`。
> - 每个平台脚本的解析选择器**必须**对照 `tests/fixtures/` 里抓下来的真实页面填写并断言，禁止凭记忆写选择器。
> - 提交信息用中文，conventional commits 风格。

---

## Task 1: 脚手架 + 依赖 + 确认 Scrapling 真实 API

**Files:**
- Create: `tools/ota-reviews/requirements.txt`
- Create: `tools/ota-reviews/scripts/__init__.py`（空文件）
- Create: `tools/ota-reviews/tests/__init__.py`（空文件）
- Create: `tools/ota-reviews/tests/fixtures/.gitkeep`（空文件）
- Create: `tools/ota-reviews/.gitignore`
- Create: `tools/ota-reviews/pytest.ini`

- [ ] **Step 1: 建目录与空文件**

```bash
cd /Users/grant/Meta1/meshbot
mkdir -p tools/ota-reviews/scripts tools/ota-reviews/tests/fixtures
touch tools/ota-reviews/scripts/__init__.py \
      tools/ota-reviews/tests/__init__.py \
      tools/ota-reviews/tests/fixtures/.gitkeep
```

- [ ] **Step 2: 写 requirements.txt**

`tools/ota-reviews/requirements.txt`:
```
scrapling>=0.2.9
pydantic>=2.6
pytest>=8.0
```

- [ ] **Step 3: 写 .gitignore（不提交 venv / 落库产物 / 大体积 fixture 二进制）**

`tools/ota-reviews/.gitignore`:
```
.venv/
__pycache__/
*.pyc
.pytest_cache/
exports/
*.db
*.db-*
```

- [ ] **Step 4: 写 pytest.ini（注册 live 标记，默认不跑联网测试）**

`tools/ota-reviews/pytest.ini`:
```ini
[pytest]
markers =
    live: 真实联网抓取的 smoke 测试（默认跳过，加 -m live 显式运行）
addopts = -m "not live"
testpaths = tests
```

- [ ] **Step 5: 建 venv 并安装依赖**

```bash
cd /Users/grant/Meta1/meshbot/tools/ota-reviews
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```
Expected: 安装成功，无报错。

- [ ] **Step 6: 确认 Scrapling 实际 API（版本间有差异，必须实测）**

```bash
cd /Users/grant/Meta1/meshbot/tools/ota-reviews && . .venv/bin/activate
python -c "import scrapling; print('version:', scrapling.__version__)"
python -c "from scrapling.fetchers import StealthyFetcher; print([m for m in dir(StealthyFetcher) if not m.startswith('_')])"
```
Expected: 打印出版本号，以及 `StealthyFetcher` 的可用方法（应包含 `fetch`）。
**记录**：把实际可用的抓取入口方法名（`fetch` 还是别的）与返回对象的查询方法（`css` / `css_first` / `xpath` / `find_all` 等）记在 `<SKILL>/scripts/SCRAPLING_API.md` 一行备忘，后续 fetch 封装与解析以此为准。
> 若 Camoufox/浏览器二进制需要额外下载（StealthyFetcher 首次运行会提示），按其提示执行（如 `python -m camoufox fetch` 或 scrapling 文档给出的命令），并把该命令补进 SKILL.md「安装」节。

- [ ] **Step 7: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/requirements.txt \
        tools/ota-reviews/scripts/__init__.py \
        tools/ota-reviews/tests/__init__.py \
        tools/ota-reviews/tests/fixtures/.gitkeep \
        tools/ota-reviews/.gitignore \
        tools/ota-reviews/pytest.ini \
        tools/ota-reviews/scripts/SCRAPLING_API.md
git commit -m "feat(ota-reviews): 脚手架 + 依赖 + 确认 Scrapling API"
```

---

## Task 2: Review 数据模型

**Files:**
- Create: `tools/ota-reviews/scripts/models.py`
- Test: `tools/ota-reviews/tests/test_models.py`

- [ ] **Step 1: 写失败测试**

`tests/test_models.py`:
```python
from datetime import datetime
from scripts.models import Review


def test_review_minimal_fields_ok():
    r = Review(
        site="tripadvisor",
        hotel_key="magellan-sutera",
        review_id="abc123",
        text="Great stay",
    )
    assert r.site == "tripadvisor"
    assert r.review_id == "abc123"
    assert r.rating is None
    assert isinstance(r.scraped_at, datetime)


def test_review_dedup_key():
    r = Review(site="agoda", hotel_key="h1", review_id="x9", text="ok")
    assert r.dedup_key() == ("agoda", "x9")


def test_review_rating_coerced_to_float():
    r = Review(site="booking", hotel_key="h1", review_id="r1", text="ok", rating="8.5")
    assert r.rating == 8.5
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/grant/Meta1/meshbot/tools/ota-reviews && . .venv/bin/activate
pytest tests/test_models.py -v
```
Expected: FAIL（`ModuleNotFoundError: scripts.models`）。

- [ ] **Step 3: 实现 models.py**

`scripts/models.py`:
```python
from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, Field


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Review(BaseModel):
    site: str                       # tripadvisor / trip / agoda / booking
    hotel_key: str                  # targets.json 里跨平台共用的酒店标识
    review_id: str                  # 平台内评论唯一 ID
    text: str
    hotel_name: str | None = None
    author: str | None = None
    rating: float | None = None
    title: str | None = None
    date: str | None = None         # ISO 8601 字符串，解析不到则 None
    language: str | None = None
    trip_type: str | None = None
    raw: dict | None = None         # 原始片段，便于回溯
    scraped_at: datetime = Field(default_factory=_now)

    def dedup_key(self) -> tuple[str, str]:
        return (self.site, self.review_id)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pytest tests/test_models.py -v
```
Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/scripts/models.py tools/ota-reviews/tests/test_models.py
git commit -m "feat(ota-reviews): Review 数据模型 + 去重键"
```

---

## Task 3: SQLite 去重存储

**Files:**
- Create: `tools/ota-reviews/scripts/store.py`
- Test: `tools/ota-reviews/tests/test_store.py`

- [ ] **Step 1: 写失败测试**

`tests/test_store.py`:
```python
from scripts.models import Review
from scripts.store import ReviewStore


def _r(review_id: str, text: str = "ok") -> Review:
    return Review(site="tripadvisor", hotel_key="h1", review_id=review_id, text=text)


def test_upsert_returns_new_count(tmp_path):
    store = ReviewStore(tmp_path / "r.db")
    new = store.upsert([_r("a"), _r("b")])
    assert new == 2


def test_upsert_dedups_same_site_review_id(tmp_path):
    store = ReviewStore(tmp_path / "r.db")
    store.upsert([_r("a")])
    new = store.upsert([_r("a"), _r("c")])
    assert new == 1                       # a 已存在，只新增 c
    assert store.count() == 2


def test_upsert_updates_existing_text(tmp_path):
    store = ReviewStore(tmp_path / "r.db")
    store.upsert([_r("a", text="old")])
    store.upsert([_r("a", text="new")])
    rows = store.all()
    assert len(rows) == 1
    assert rows[0]["text"] == "new"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pytest tests/test_store.py -v
```
Expected: FAIL（`ModuleNotFoundError: scripts.store`）。

- [ ] **Step 3: 实现 store.py**

`scripts/store.py`:
```python
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from scripts.models import Review

_SCHEMA = """
CREATE TABLE IF NOT EXISTS reviews (
    site        TEXT NOT NULL,
    review_id   TEXT NOT NULL,
    hotel_key   TEXT NOT NULL,
    hotel_name  TEXT,
    author      TEXT,
    rating      REAL,
    title       TEXT,
    text        TEXT NOT NULL,
    date        TEXT,
    language    TEXT,
    trip_type   TEXT,
    raw         TEXT,
    scraped_at  TEXT NOT NULL,
    PRIMARY KEY (site, review_id)
);
"""


class ReviewStore:
    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)

    def upsert(self, reviews: list[Review]) -> int:
        """写入评论，按 (site, review_id) 去重 upsert。返回本次新增（非更新）条数。"""
        new_count = 0
        cur = self._conn.cursor()
        for r in reviews:
            existing = cur.execute(
                "SELECT 1 FROM reviews WHERE site=? AND review_id=?",
                (r.site, r.review_id),
            ).fetchone()
            if existing is None:
                new_count += 1
            cur.execute(
                """
                INSERT INTO reviews
                  (site, review_id, hotel_key, hotel_name, author, rating, title,
                   text, date, language, trip_type, raw, scraped_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(site, review_id) DO UPDATE SET
                  hotel_key=excluded.hotel_key, hotel_name=excluded.hotel_name,
                  author=excluded.author, rating=excluded.rating, title=excluded.title,
                  text=excluded.text, date=excluded.date, language=excluded.language,
                  trip_type=excluded.trip_type, raw=excluded.raw,
                  scraped_at=excluded.scraped_at
                """,
                (
                    r.site, r.review_id, r.hotel_key, r.hotel_name, r.author,
                    r.rating, r.title, r.text, r.date, r.language, r.trip_type,
                    json.dumps(r.raw, ensure_ascii=False) if r.raw is not None else None,
                    r.scraped_at.isoformat(),
                ),
            )
        self._conn.commit()
        return new_count

    def count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]

    def all(self) -> list[dict]:
        rows = self._conn.execute("SELECT * FROM reviews").fetchall()
        return [dict(row) for row in rows]

    def by(self, site: str, hotel_key: str) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM reviews WHERE site=? AND hotel_key=? ORDER BY date DESC",
            (site, hotel_key),
        ).fetchall()
        return [dict(row) for row in rows]
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pytest tests/test_store.py -v
```
Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/scripts/store.py tools/ota-reviews/tests/test_store.py
git commit -m "feat(ota-reviews): SQLite 去重存储"
```

---

## Task 4: JSON 导出

**Files:**
- Modify: `tools/ota-reviews/scripts/store.py`（新增 `export_json`）
- Test: `tools/ota-reviews/tests/test_export.py`

- [ ] **Step 1: 写失败测试**

`tests/test_export.py`:
```python
import json

from scripts.models import Review
from scripts.store import ReviewStore


def test_export_json_writes_file(tmp_path):
    store = ReviewStore(tmp_path / "r.db")
    store.upsert([Review(site="trip", hotel_key="h1", review_id="z1", text="hi")])
    out = store.export_json("trip", "h1", tmp_path / "exports", date_str="2026-05-30")
    assert out.exists()
    assert out.name == "trip-h1-2026-05-30.json"
    data = json.loads(out.read_text(encoding="utf-8"))
    assert len(data) == 1
    assert data[0]["review_id"] == "z1"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pytest tests/test_export.py -v
```
Expected: FAIL（`AttributeError: 'ReviewStore' object has no attribute 'export_json'`）。

- [ ] **Step 3: 在 store.py 末尾的类内新增方法**

在 `ReviewStore` 类内追加：
```python
    def export_json(
        self, site: str, hotel_key: str, out_dir: Path | str, date_str: str
    ) -> Path:
        """把某站某酒店的评论导出为 JSON 文件，返回写入路径。"""
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        rows = self.by(site, hotel_key)
        out = out_dir / f"{site}-{hotel_key}-{date_str}.json"
        out.write_text(
            json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return out
```
（`Path` 与 `json` 已在文件顶部导入。）

- [ ] **Step 4: 跑测试确认通过**

```bash
pytest tests/test_export.py -v
```
Expected: 1 passed。

- [ ] **Step 5: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/scripts/store.py tools/ota-reviews/tests/test_export.py
git commit -m "feat(ota-reviews): 评论 JSON 导出"
```

---

## Task 5: targets 配置加载

**Files:**
- Create: `tools/ota-reviews/targets.json`
- Create: `tools/ota-reviews/scripts/targets.py`
- Test: `tools/ota-reviews/tests/test_targets.py`

- [ ] **Step 1: 写 targets.json（先放 1 个已知目标 + 占位结构）**

`tools/ota-reviews/targets.json`:
```json
{
  "magellan-sutera": {
    "hotel_name": "The Magellan Sutera Resort",
    "platforms": {
      "tripadvisor": "https://cn.tripadvisor.com/Hotel_Review-g298307-d16659663-Reviews-The_Magellan_Sutera_Resort-Kota_Kinabalu_Kota_Kinabalu_District_West_Coast_Division_S.html",
      "trip": "",
      "agoda": "",
      "booking": ""
    }
  },
  "hotel-2-placeholder": {
    "hotel_name": "",
    "platforms": { "tripadvisor": "", "trip": "", "agoda": "", "booking": "" }
  }
}
```
> 第二个酒店与各空 URL 由用户后续填入（见最后的「开口项」任务）。

- [ ] **Step 2: 写失败测试**

`tests/test_targets.py`:
```python
import json

import pytest

from scripts.targets import load_target, TargetNotFound


def _write(tmp_path, data):
    p = tmp_path / "targets.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def test_load_target_returns_url_and_name(tmp_path):
    p = _write(tmp_path, {
        "h1": {"hotel_name": "Hotel One",
               "platforms": {"tripadvisor": "http://x", "trip": "", "agoda": "", "booking": ""}},
    })
    t = load_target(p, "tripadvisor", "h1")
    assert t["url"] == "http://x"
    assert t["hotel_name"] == "Hotel One"
    assert t["hotel_key"] == "h1"


def test_load_target_missing_hotel_raises(tmp_path):
    p = _write(tmp_path, {})
    with pytest.raises(TargetNotFound):
        load_target(p, "tripadvisor", "nope")


def test_load_target_empty_url_raises(tmp_path):
    p = _write(tmp_path, {
        "h1": {"hotel_name": "H", "platforms": {"agoda": ""}},
    })
    with pytest.raises(TargetNotFound):
        load_target(p, "agoda", "h1")
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pytest tests/test_targets.py -v
```
Expected: FAIL（`ModuleNotFoundError: scripts.targets`）。

- [ ] **Step 4: 实现 targets.py**

`scripts/targets.py`:
```python
from __future__ import annotations

import json
from pathlib import Path


class TargetNotFound(Exception):
    pass


def load_target(targets_path: Path | str, site: str, hotel_key: str) -> dict:
    """从 targets.json 取某酒店在某平台的抓取目标。url 缺失或为空即报错。"""
    data = json.loads(Path(targets_path).read_text(encoding="utf-8"))
    hotel = data.get(hotel_key)
    if hotel is None:
        raise TargetNotFound(f"未找到酒店 {hotel_key!r}")
    url = (hotel.get("platforms") or {}).get(site, "")
    if not url:
        raise TargetNotFound(f"酒店 {hotel_key!r} 在平台 {site!r} 没有配置 URL")
    return {"url": url, "hotel_name": hotel.get("hotel_name") or None, "hotel_key": hotel_key}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pytest tests/test_targets.py -v
```
Expected: 3 passed。

- [ ] **Step 6: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/targets.json \
        tools/ota-reviews/scripts/targets.py \
        tools/ota-reviews/tests/test_targets.py
git commit -m "feat(ota-reviews): targets 配置加载"
```

---

## Task 6: CLI 编排（common.run）

把「加载 target → 调用平台 scrape 函数 → upsert → 导出 → 打印汇总」编排起来，平台脚本只需提供 `scrape(target, max_reviews, fetch) -> list[Review]`。

**Files:**
- Create: `tools/ota-reviews/scripts/runner.py`
- Test: `tools/ota-reviews/tests/test_runner.py`

- [ ] **Step 1: 写失败测试（用假 scrape 函数，不联网）**

`tests/test_runner.py`:
```python
from datetime import date

from scripts.models import Review
from scripts.runner import run


def test_run_stores_and_exports_and_returns_summary(tmp_path, monkeypatch):
    # 假平台：返回 2 条评论，不联网
    def fake_scrape(target, max_reviews, fetch):
        return [
            Review(site="tripadvisor", hotel_key=target["hotel_key"], review_id="a", text="x"),
            Review(site="tripadvisor", hotel_key=target["hotel_key"], review_id="b", text="y"),
        ]

    targets = tmp_path / "targets.json"
    targets.write_text(
        '{"h1":{"hotel_name":"H","platforms":{"tripadvisor":"http://x"}}}',
        encoding="utf-8",
    )

    summary = run(
        site="tripadvisor",
        scrape_fn=fake_scrape,
        hotel_key="h1",
        max_reviews=100,
        targets_path=targets,
        out_root=tmp_path / "out",
        fetch=None,
    )
    assert summary["new"] == 2
    assert summary["total"] == 2
    assert summary["export"].endswith(f"tripadvisor-h1-{date.today().isoformat()}.json")
    assert (tmp_path / "out" / "reviews.db").exists()
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pytest tests/test_runner.py -v
```
Expected: FAIL（`ModuleNotFoundError: scripts.runner`）。

- [ ] **Step 3: 实现 runner.py**

`scripts/runner.py`:
```python
from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path
from typing import Callable

from scripts.models import Review
from scripts.store import ReviewStore
from scripts.targets import load_target

ScrapeFn = Callable[[dict, int, object], list[Review]]


def run(
    *,
    site: str,
    scrape_fn: ScrapeFn,
    hotel_key: str,
    max_reviews: int,
    targets_path: Path | str,
    out_root: Path | str,
    fetch: object,
) -> dict:
    """编排单次抓取：加载 target → scrape → upsert → 导出 → 返回汇总。"""
    target = load_target(targets_path, site, hotel_key)
    reviews = scrape_fn(target, max_reviews, fetch)
    out_root = Path(out_root)
    store = ReviewStore(out_root / "reviews.db")
    new = store.upsert(reviews)
    export = store.export_json(
        site, hotel_key, out_root / "exports", date_str=date.today().isoformat()
    )
    return {
        "site": site,
        "hotel_key": hotel_key,
        "scraped": len(reviews),
        "new": new,
        "total": store.count(),
        "export": str(export),
    }


def default_out_root() -> Path:
    """落库根：<meshbotDir>/workspace/ota-reviews/。meshbotDir 默认 ~/.meshbot，
    可用 MESHBOT_DIR 覆盖（与 server-agent 的 resolveMeshbotDir 对齐）。"""
    import os

    base = os.environ.get("MESHBOT_DIR") or str(Path.home() / ".meshbot")
    return Path(base) / "workspace" / "ota-reviews"


def main(site: str, scrape_fn: ScrapeFn, fetch_factory: Callable[[], object]) -> None:
    """平台脚本的统一入口：解析 CLI 参数并调用 run，打印汇总。"""
    parser = argparse.ArgumentParser(description=f"{site} 评论抓取")
    parser.add_argument("--hotel", required=True, help="targets.json 里的酒店 key")
    parser.add_argument("--max-reviews", type=int, default=200)
    parser.add_argument(
        "--targets",
        default=str(Path(__file__).resolve().parent.parent / "targets.json"),
    )
    parser.add_argument("--out", default=None, help="落库根目录，默认 workspace/ota-reviews")
    args = parser.parse_args()

    out_root = Path(args.out) if args.out else default_out_root()
    summary = run(
        site=site,
        scrape_fn=scrape_fn,
        hotel_key=args.hotel,
        max_reviews=args.max_reviews,
        targets_path=args.targets,
        out_root=out_root,
        fetch=fetch_factory(),
    )
    print(
        f"[{site}] hotel={summary['hotel_key']} "
        f"scraped={summary['scraped']} new={summary['new']} total={summary['total']}"
    )
    print(f"[{site}] export -> {summary['export']}")
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pytest tests/test_runner.py -v
```
Expected: 1 passed。

- [ ] **Step 5: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/scripts/runner.py tools/ota-reviews/tests/test_runner.py
git commit -m "feat(ota-reviews): CLI 编排 runner"
```

---

## Task 7: Scrapling fetch 封装

封装一个 `make_fetch()` 工厂，返回一个 `fetch(url, *, wait_for=None, proxy=None) -> page` 函数。把 Scrapling 的 stealth 配置、礼貌延迟、代理预留集中在这里。**用 Task 1 Step 6 记录的真实 API 名**。

**Files:**
- Create: `tools/ota-reviews/scripts/fetcher.py`
- Test: `tools/ota-reviews/tests/test_fetcher.py`

- [ ] **Step 1: 写失败测试（mock 掉 StealthyFetcher，不联网）**

`tests/test_fetcher.py`:
```python
from scripts import fetcher


def test_fetch_passes_url_and_stealth_opts(monkeypatch):
    calls = {}

    class FakeFetcher:
        @staticmethod
        def fetch(url, **kw):
            calls["url"] = url
            calls["kw"] = kw
            return "PAGE"

    monkeypatch.setattr(fetcher, "StealthyFetcher", FakeFetcher)
    f = fetcher.make_fetch(delay_range=(0, 0))   # 测试里关掉真实延迟
    page = f("http://example.com")
    assert page == "PAGE"
    assert calls["url"] == "http://example.com"
    assert calls["kw"].get("headless") is True


def test_fetch_forwards_proxy(monkeypatch):
    calls = {}

    class FakeFetcher:
        @staticmethod
        def fetch(url, **kw):
            calls["kw"] = kw
            return "PAGE"

    monkeypatch.setattr(fetcher, "StealthyFetcher", FakeFetcher)
    f = fetcher.make_fetch(delay_range=(0, 0), proxy="http://user:pass@host:8080")
    f("http://example.com")
    assert calls["kw"].get("proxy") == "http://user:pass@host:8080"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pytest tests/test_fetcher.py -v
```
Expected: FAIL（`ModuleNotFoundError: scripts.fetcher`）。

- [ ] **Step 3: 实现 fetcher.py**

> 注意：`StealthyFetcher.fetch` 的参数名以 Task 1 Step 6 实测为准。下方用常见参数 `headless` / `network_idle` / `proxy`；若实测版本参数名不同（如 `proxy` 写法不同），按实测改，并同步改测试断言。`wait_for` 用于等待评论容器出现的选择器（Scrapling 对应参数名也以实测为准，常见为 `wait_selector`）。

`scripts/fetcher.py`:
```python
from __future__ import annotations

import random
import time
from typing import Callable

from scrapling.fetchers import StealthyFetcher


def make_fetch(
    *,
    proxy: str | None = None,
    delay_range: tuple[float, float] = (2.0, 5.0),
    wait_for: str | None = None,
) -> Callable[..., object]:
    """返回一个礼貌的 stealth fetch 函数。

    - 每次请求前随机 sleep（delay_range），降低被识别为机器人的概率。
    - proxy 为 None 时不走代理（裸跑）；以后接代理池只需传入。
    - 单进程串行使用，不并发。
    """

    def fetch(url: str, *, wait_for_override: str | None = None) -> object:
        lo, hi = delay_range
        if hi > 0:
            time.sleep(random.uniform(lo, hi))
        kw: dict = {"headless": True, "network_idle": True}
        sel = wait_for_override or wait_for
        if sel:
            kw["wait_selector"] = sel
        if proxy:
            kw["proxy"] = proxy
        return StealthyFetcher.fetch(url, **kw)

    return fetch
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pytest tests/test_fetcher.py -v
```
Expected: 2 passed。

- [ ] **Step 5: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/scripts/fetcher.py tools/ota-reviews/tests/test_fetcher.py
git commit -m "feat(ota-reviews): Scrapling stealth fetch 封装 + 代理预留"
```

---

## Task 8: TripAdvisor 适配器（解析，对 fixture 做 TDD）

这是「捕获真实页面 → 冻结成 fixture → 对 fixture 写解析测试 → 实现解析」的样板，后续 3 个平台照此办理。

**Files:**
- Create: `tools/ota-reviews/tests/fixtures/tripadvisor_sample.html`（抓取产物）
- Create: `tools/ota-reviews/scripts/tripadvisor.py`
- Test: `tools/ota-reviews/tests/test_tripadvisor.py`

- [ ] **Step 1: 捕获真实页面到 fixture（一次性 spike，不进自动测试）**

```bash
cd /Users/grant/Meta1/meshbot/tools/ota-reviews && . .venv/bin/activate
python - <<'PY'
from scripts.fetcher import make_fetch
url = "https://cn.tripadvisor.com/Hotel_Review-g298307-d16659663-Reviews-The_Magellan_Sutera_Resort-Kota_Kinabalu_Kota_Kinabalu_District_West_Coast_Division_S.html"
page = make_fetch(delay_range=(0, 0), wait_for="body")(url)
html = page.html_content if hasattr(page, "html_content") else str(page)
open("tests/fixtures/tripadvisor_sample.html", "w", encoding="utf-8").write(html)
print("saved", len(html), "bytes")
PY
```
Expected: 保存若干 KB 的 HTML。
> 若被反爬挡住（返回验证码页/极短 HTML），记录现象：TripAdvisor 是本期最可能成功的站，若它都被挡，需在 SKILL.md 标注「裸跑不可行，需代理」并把后续平台一并降级为 best-effort。`page` 取 HTML 的属性名以 Task 1 Step 6 实测为准（常见 `html_content` / `.body` / `str(page)`）。

- [ ] **Step 2: 人工读 fixture，定位评论的真实选择器**

```bash
# 打开 fixture，搜索一条你在网页上看到的评论正文，定位其外层容器/类名
grep -o 'data-reviewid="[^"]*"' tests/fixtures/tripadvisor_sample.html | head
```
把观察到的：评论卡片容器选择器、review_id 来源（如 `data-reviewid` 属性）、正文/标题/评分/作者/日期的选择器，记在 `test_tripadvisor.py` 顶部注释里，供 Step 3 断言与 Step 5 实现共用。

- [ ] **Step 3: 写失败测试（对 fixture 解析，断言已知内容）**

`tests/test_tripadvisor.py`:
```python
from pathlib import Path

from scripts.tripadvisor import parse_reviews

FIXTURE = Path(__file__).parent / "fixtures" / "tripadvisor_sample.html"


def test_parse_reviews_extracts_nonempty_list():
    html = FIXTURE.read_text(encoding="utf-8")
    reviews = parse_reviews(html, hotel_key="magellan-sutera", hotel_name="The Magellan Sutera Resort")
    assert len(reviews) > 0
    first = reviews[0]
    assert first.site == "tripadvisor"
    assert first.hotel_key == "magellan-sutera"
    assert first.review_id            # 非空
    assert first.text.strip()         # 非空正文


def test_parse_reviews_review_ids_unique():
    html = FIXTURE.read_text(encoding="utf-8")
    reviews = parse_reviews(html, hotel_key="magellan-sutera", hotel_name=None)
    ids = [r.review_id for r in reviews]
    assert len(ids) == len(set(ids))
```

- [ ] **Step 4: 跑测试确认失败**

```bash
pytest tests/test_tripadvisor.py -v
```
Expected: FAIL（`ModuleNotFoundError: scripts.tripadvisor`）。

- [ ] **Step 5: 实现 tripadvisor.py（解析用 Step 2 的真实选择器填，下方为结构骨架）**

> 解析函数 `parse_reviews(html, *, hotel_key, hotel_name) -> list[Review]` 必须只依赖传入的 HTML 字符串（纯函数，可测）。用 Scrapling 的解析能力或直接用其底层选择器；解析对象的构造方式以 Task 1 Step 6 实测为准（常见：`from scrapling import Adaptor; page = Adaptor(html)` 然后 `page.css(...)`）。**下面的 CSS 选择器是占位示例，必须替换为 Step 2 在 fixture 里确认的真实选择器。**

`scripts/tripadvisor.py`:
```python
from __future__ import annotations

from scrapling import Adaptor  # 构造方式以实测为准

from scripts.models import Review
from scripts.fetcher import make_fetch
from scripts.runner import main


def parse_reviews(html: str, *, hotel_key: str, hotel_name: str | None) -> list[Review]:
    page = Adaptor(html)
    out: list[Review] = []
    # ↓↓↓ 选择器替换为 Step 2 在 fixture 中确认的真实值 ↓↓↓
    cards = page.css('div[data-reviewid]')
    for card in cards:
        review_id = card.attrib.get("data-reviewid", "").strip()
        text = card.css_first('span[class*="review"] ::text') or ""
        title = card.css_first('a[class*="title"] ::text') or None
        if not review_id or not text.strip():
            continue
        out.append(
            Review(
                site="tripadvisor",
                hotel_key=hotel_key,
                hotel_name=hotel_name,
                review_id=review_id,
                text=text.strip(),
                title=title.strip() if title else None,
                raw={"reviewid": review_id},
            )
        )
    return out


def scrape(target: dict, max_reviews: int, fetch) -> list[Review]:
    """抓取 + 翻页 + 解析。翻页逻辑见 Task 9。"""
    page = fetch(target["url"], wait_for_override='div[data-reviewid]')
    html = page.html_content if hasattr(page, "html_content") else str(page)
    return parse_reviews(html, hotel_key=target["hotel_key"], hotel_name=target["hotel_name"])


if __name__ == "__main__":
    main("tripadvisor", scrape, lambda: make_fetch())
```

- [ ] **Step 6: 跑测试确认通过**

```bash
pytest tests/test_tripadvisor.py -v
```
Expected: 2 passed（如失败，回 Step 2 修正选择器，再跑）。

- [ ] **Step 7: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/scripts/tripadvisor.py \
        tools/ota-reviews/tests/test_tripadvisor.py \
        tools/ota-reviews/tests/fixtures/tripadvisor_sample.html
git commit -m "feat(ota-reviews): TripAdvisor 解析器（对 fixture TDD）"
```

---

## Task 9: TripAdvisor 翻页 + 富字段 + 联网 smoke

- [ ] **Step 1: 在 fixture 里定位「下一页」链接 / 分页 URL 规律**

TripAdvisor 评论分页通常体现在 URL 的 `-orNN-` 段（NN = 偏移）。在 Step 1 的 fixture 里 `grep -o '-or[0-9]*-' tests/fixtures/tripadvisor_sample.html | head` 确认规律；或定位「下一页」按钮的 href。

- [ ] **Step 2: 写翻页单测（构造两页 fixture 验证 URL 推进，不联网）**

在 `test_tripadvisor.py` 增加：
```python
from scripts.tripadvisor import next_page_url


def test_next_page_url_advances_offset():
    base = "https://cn.tripadvisor.com/Hotel_Review-g1-d2-Reviews-Name.html"
    assert next_page_url(base, page_index=1) == \
        "https://cn.tripadvisor.com/Hotel_Review-g1-d2-Reviews-or10-Name.html"
```
> 偏移步长（每页评论数，常见 10）以 fixture 实测为准，必要时调整断言。

- [ ] **Step 3: 跑测试确认失败**

```bash
pytest tests/test_tripadvisor.py::test_next_page_url_advances_offset -v
```
Expected: FAIL（`next_page_url` 未定义）。

- [ ] **Step 4: 实现 next_page_url 并在 scrape 中翻页直到 max_reviews/无更多**

在 `tripadvisor.py` 增加（正则按 Step 1 实测调整）：
```python
import re

_PER_PAGE = 10  # 以 fixture 实测为准


def next_page_url(url: str, *, page_index: int) -> str:
    """构造第 page_index 页的 URL（page_index 从 0 开始；0 即原始 URL）。"""
    offset = page_index * _PER_PAGE
    marker = f"-Reviews-"
    if offset == 0:
        return url
    return url.replace(marker, f"{marker}or{offset}-", 1)
```
并把 `scrape` 改为循环翻页：
```python
def scrape(target: dict, max_reviews: int, fetch) -> list[Review]:
    collected: list[Review] = []
    seen: set[str] = set()
    page_index = 0
    while len(collected) < max_reviews:
        url = next_page_url(target["url"], page_index=page_index)
        page = fetch(url, wait_for_override='div[data-reviewid]')
        html = page.html_content if hasattr(page, "html_content") else str(page)
        batch = parse_reviews(html, hotel_key=target["hotel_key"], hotel_name=target["hotel_name"])
        fresh = [r for r in batch if r.review_id not in seen]
        if not fresh:
            break                      # 无新评论 → 到底
        for r in fresh:
            seen.add(r.review_id)
        collected.extend(fresh)
        page_index += 1
    return collected[:max_reviews]
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pytest tests/test_tripadvisor.py -v
```
Expected: 全部 passed。

- [ ] **Step 6: 联网 smoke 测试（标 live，默认跳过）**

新增 `tests/test_live_tripadvisor.py`:
```python
import os

import pytest

pytestmark = pytest.mark.live


@pytest.mark.skipif(not os.environ.get("RUN_LIVE"), reason="需 RUN_LIVE=1 显式开启")
def test_live_tripadvisor_scrape_returns_reviews():
    from scripts.fetcher import make_fetch
    from scripts.targets import load_target
    from scripts.tripadvisor import scrape
    from pathlib import Path

    targets = Path(__file__).parent.parent / "targets.json"
    target = load_target(targets, "tripadvisor", "magellan-sutera")
    reviews = scrape(target, max_reviews=15, fetch=make_fetch())
    assert len(reviews) > 0
```
手动验证：
```bash
RUN_LIVE=1 pytest tests/test_live_tripadvisor.py -m live -v
```
Expected: 抓到 >0 条评论（若被反爬挡 → 记录并在 SKILL.md 标注）。

- [ ] **Step 7: 端到端手动跑一次**

```bash
cd /Users/grant/Meta1/meshbot/tools/ota-reviews/scripts && . ../.venv/bin/activate
python tripadvisor.py --hotel magellan-sutera --max-reviews 15 --out /tmp/ota-test
```
Expected: 打印 `scraped/new/total` 与 export 路径；`/tmp/ota-test/reviews.db` 和 exports JSON 生成。

- [ ] **Step 8: Commit**

```bash
cd /Users/grant/Meta1/meshbot
git add tools/ota-reviews/scripts/tripadvisor.py \
        tools/ota-reviews/tests/test_tripadvisor.py \
        tools/ota-reviews/tests/test_live_tripadvisor.py
git commit -m "feat(ota-reviews): TripAdvisor 翻页 + 联网 smoke"
```

---

## Task 10: Trip.com 适配器

照 Task 8–9 的「捕获 fixture → TDD 解析 → 翻页 → smoke」流程做 Trip.com。Trip.com 评论常通过内部 JSON 接口加载，**优先尝试 JSON 接口**（请求更少、更稳），HTML 解析作兜底。

**Files:**
- Create: `tools/ota-reviews/tests/fixtures/trip_sample.html`（或 `trip_sample.json`，取决于走哪条路）
- Create: `tools/ota-reviews/scripts/trip.py`
- Test: `tools/ota-reviews/tests/test_trip.py`

- [ ] **Step 1: 填 targets.json 的 trip URL**：把 `magellan-sutera.platforms.trip` 填成 Trip.com 上该酒店的评论页 URL（在 Trip.com 搜到酒店、复制其详情/评论页链接）。

- [ ] **Step 2: 捕获 fixture**：仿 Task 8 Step 1，把 `wait_for` 设为评论容器选择器；保存到 `tests/fixtures/trip_sample.html`。若发现评论来自某 XHR JSON 接口（浏览器开发者工具 Network 里找），改为直接请求该接口并存 `trip_sample.json`。

- [ ] **Step 3: 读 fixture 定位选择器/JSON 字段**（仿 Task 8 Step 2）。

- [ ] **Step 4: 写失败测试** `tests/test_trip.py`（结构同 `test_tripadvisor.py`，把 `site` 改为 `"trip"`、fixture 改为 trip 的）：
```python
from pathlib import Path

from scripts.trip import parse_reviews

FIXTURE = Path(__file__).parent / "fixtures" / "trip_sample.html"


def test_parse_reviews_nonempty():
    reviews = parse_reviews(FIXTURE.read_text(encoding="utf-8"),
                            hotel_key="magellan-sutera", hotel_name=None)
    assert len(reviews) > 0
    assert reviews[0].site == "trip"
    assert reviews[0].review_id
    assert reviews[0].text.strip()


def test_parse_reviews_unique_ids():
    reviews = parse_reviews(FIXTURE.read_text(encoding="utf-8"),
                            hotel_key="magellan-sutera", hotel_name=None)
    ids = [r.review_id for r in reviews]
    assert len(ids) == len(set(ids))
```

- [ ] **Step 5: 跑测试确认失败**：`pytest tests/test_trip.py -v` → FAIL（模块缺失）。

- [ ] **Step 6: 实现 trip.py**：结构同 `tripadvisor.py`（`parse_reviews` + `scrape` + `__main__` 调 `main("trip", scrape, lambda: make_fetch())`）。选择器/JSON 解析用 Step 3 的真实值。翻页按 Trip.com 实际机制（JSON 接口通常带 `pageIndex`/`pageSize` 参数；HTML 则找下一页）。site 字面量全部用 `"trip"`。

- [ ] **Step 7: 跑测试确认通过**：`pytest tests/test_trip.py -v` → passed。

- [ ] **Step 8: 联网 smoke**：仿 Task 9 Step 6 建 `tests/test_live_trip.py`（site=trip，hotel_key=magellan-sutera）。`RUN_LIVE=1 pytest tests/test_live_trip.py -m live -v`。

- [ ] **Step 9: Commit**：
```bash
git add tools/ota-reviews/scripts/trip.py \
        tools/ota-reviews/tests/test_trip.py \
        tools/ota-reviews/tests/test_live_trip.py \
        tools/ota-reviews/tests/fixtures/trip_sample.* \
        tools/ota-reviews/targets.json
git commit -m "feat(ota-reviews): Trip.com 适配器"
```

---

## Task 11: Agoda 适配器（best-effort）

照 Task 10 流程做 Agoda。**预期反爬强，裸跑可能被挡**——这是 best-effort：

- [ ] **Step 1: 填 targets.json 的 agoda URL**（该酒店在 Agoda 的页面）。
- [ ] **Step 2: 捕获 fixture**：Agoda 评论几乎肯定走带 token 的内部 JSON 接口。先尝试 HTML（`agoda_sample.html`）；若评论不在 HTML 里，用开发者工具找评论 XHR（通常是 `gateway`/`review` 类接口），存 `agoda_sample.json`。
- [ ] **Step 3: 读 fixture 定位字段**。
- [ ] **Step 4–7: 解析 TDD**：建 `scripts/agoda.py` + `tests/test_agoda.py`，结构同 Task 10，site=`"agoda"`。
- [ ] **Step 8: 联网 smoke**：`tests/test_live_agoda.py`。**若被挡**：让 smoke 测试在检测到验证码/403 时 `pytest.skip("blocked, 需代理")`，并在 SKILL.md 标注 Agoda 为 best-effort、建议接代理。
- [ ] **Step 9: 检测到封锁时的退出语义**：在 `agoda.py` 的 `scrape` 里，若抓到的页面是挑战页（用 fixture 不可断言，靠运行时启发：HTML 极短 / 含 "captcha"/"Access Denied"），抛 `RuntimeError("BLOCKED: 需要代理")`。runner 的 `main` 让异常向上冒泡，进程非 0 退出 —— agent 逐站跑时单站失败不影响其他站。
- [ ] **Step 10: Commit**：`feat(ota-reviews): Agoda 适配器（best-effort）`。

---

## Task 12: Booking 适配器（best-effort）

照 Task 11 流程做 Booking。**Cloudflare + 行为检测，裸跑预期最难**：

- [ ] **Step 1: 填 targets.json 的 booking URL**。
- [ ] **Step 2: 捕获 fixture**：Booking 评论常在 `/reviewlist` 类接口或独立评论弹层。先 HTML（`booking_sample.html`），不行则找评论 XHR 存 `booking_sample.json`。
- [ ] **Step 3: 读 fixture 定位字段**。
- [ ] **Step 4–7: 解析 TDD**：`scripts/booking.py` + `tests/test_booking.py`，site=`"booking"`。
- [ ] **Step 8: 联网 smoke** + **封锁退出语义**：同 Task 11 Step 8–9。
- [ ] **Step 9: Commit**：`feat(ota-reviews): Booking 适配器（best-effort）`。

---

## Task 13: 第二个酒店 + 补全 targets.json

- [ ] **Step 1: 与用户确认第二个酒店**：把 `targets.json` 里 `hotel-2-placeholder` 换成真实 key（kebab-case）、`hotel_name`、以及 4 个平台的 URL。第一个酒店 magellan-sutera 的 trip/agoda/booking URL 也需补全（Task 10–12 已陆续填）。
- [ ] **Step 2: 校验配置可加载**：
```bash
cd /Users/grant/Meta1/meshbot/tools/ota-reviews && . .venv/bin/activate
python - <<'PY'
from scripts.targets import load_target
for hk in ["magellan-sutera", "<第二个酒店key>"]:
    for site in ["tripadvisor", "trip", "agoda", "booking"]:
        t = load_target("targets.json", site, hk)
        print(site, hk, "OK", t["url"][:50])
PY
```
Expected: 8 行全 OK（未填的 URL 会抛 TargetNotFound，提示还差哪个）。
- [ ] **Step 3: Commit**：`chore(ota-reviews): 补全 targets.json（2 酒店 × 4 平台）`。

---

## Task 14: SKILL.md

**Files:**
- Create: `tools/ota-reviews/SKILL.md`

- [ ] **Step 1: 写 SKILL.md**

`tools/ota-reviews/SKILL.md`:
```markdown
---
name: ota-reviews
description: 抓取固定酒店在猫途鹰/Trip.com/Agoda/Booking 四个 OTA 平台的用户评论，归一化去重落库。手动触发：用户说"抓酒店评论"时用本 skill。
---

# OTA 酒店评论抓取

抓 `targets.json` 里配置的酒店在 4 个平台的评论，去重后落库到
`<meshbotDir>/workspace/ota-reviews/reviews.db`，并导出 JSON。

## 何时用
用户要求采集/更新某酒店在 OTA 平台的评论时。当前手动触发。

## 安装（首次）
\`\`\`bash
cd <skill 目录>
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
# 若 StealthyFetcher 首次运行提示下载浏览器，按提示执行（见 scripts/SCRAPLING_API.md 备忘）
\`\`\`

## 怎么跑
每个平台一个脚本，参数一致。hotel key 见 targets.json：
\`\`\`bash
cd <skill 目录>/scripts && . ../.venv/bin/activate
python tripadvisor.py --hotel magellan-sutera --max-reviews 200
python trip.py        --hotel magellan-sutera --max-reviews 200
python agoda.py       --hotel magellan-sutera --max-reviews 200
python booking.py     --hotel magellan-sutera --max-reviews 200
\`\`\`
对每个酒店 × 每个平台各跑一次。结果累积进同一个 reviews.db（按 site+review_id 去重，可重复跑）。

## 结果在哪
- DB：`<meshbotDir>/workspace/ota-reviews/reviews.db`
- JSON 导出：`<meshbotDir>/workspace/ota-reviews/exports/<site>-<hotel>-<date>.json`

## 注意
- 单进程串行、带随机延迟，礼貌抓取；只抓公开评论页。
- TripAdvisor/Trip 裸跑通常可行；**Agoda/Booking 反爬重，裸跑可能被挡**——脚本检测到封锁会以 `BLOCKED: 需要代理` 退出（非 0），不影响其他平台。需要稳定抓取请在 fetcher 配代理。
- 选择器随网站改版会失效：失效时只需改对应平台脚本的 `parse_reviews`，并刷新该平台 fixture 后重跑其单测。

## 加新酒店
编辑 targets.json，加一个 hotel key + 4 平台 URL 即可，脚本无需改动。
```

- [ ] **Step 2: 自检 frontmatter 可被 meshbot 解析**

```bash
cd /Users/grant/Meta1/meshbot
node -e "const fs=require('fs');const raw=fs.readFileSync('tools/ota-reviews/SKILL.md','utf8');const m=raw.match(/^---\s*\n([\s\S]*?)\n---/);console.log(m? 'frontmatter OK':'NO frontmatter');console.log(/description\s*:/.test(m[1])?'has description':'MISSING description');"
```
Expected: `frontmatter OK` + `has description`。

- [ ] **Step 3: 验证 agent 能发现该 skill（若本地 server-agent 在跑）**

让 meshbot agent 调用其 `skill_list`，确认列表里出现 `ota-reviews`；再 `skill_load ota-reviews` 看正文返回且首行带 `[skill dir]`。若不便联调，跳过此步（SkillService 是纯目录扫描，结构正确即可被发现）。

- [ ] **Step 4: Commit**

```bash
git add tools/ota-reviews/SKILL.md
git commit -m "feat(ota-reviews): SKILL.md"
```

---

## Task 15: 全量回归 + 收尾

- [ ] **Step 1: 跑全部非 live 单测**

```bash
cd /Users/grant/Meta1/meshbot/tools/ota-reviews && . .venv/bin/activate
pytest -v
```
Expected: 全 passed（live 测试默认跳过）。

- [ ] **Step 2: 手动端到端跑一个酒店全 4 平台（写临时目录，不污染 workspace）**

```bash
cd tools/ota-reviews/scripts && . ../.venv/bin/activate
for s in tripadvisor trip agoda booking; do
  echo "=== $s ==="; python $s.py --hotel magellan-sutera --max-reviews 20 --out /tmp/ota-e2e || echo "[$s] 失败/被挡（best-effort 站可接受）"
done
sqlite3 /tmp/ota-e2e/reviews.db "SELECT site, COUNT(*) FROM reviews GROUP BY site;"
```
Expected: TripAdvisor/Trip 有数据；Agoda/Booking 有数据或明确 BLOCKED。

- [ ] **Step 3: 确认 .gitignore 生效（reviews.db / exports 未被跟踪）**

```bash
cd /Users/grant/Meta1/meshbot
git status --short tools/ota-reviews/
```
Expected: 无 `.db` / `exports/` 出现在待提交列表。

- [ ] **Step 4: 最终 commit（如有遗漏文件）**

```bash
git add tools/ota-reviews
git commit -m "chore(ota-reviews): 收尾回归" || echo "无新增改动"
```
```

---

## Task 15.5: 部署符号链接 + agent 发现验证

把版本控制的源码 `tools/ota-reviews/` 挂到运行时 skills 目录，让 meshbot agent 能发现。符号链接而非拷贝，避免源码与部署漂移。

**Files:**
- Create（符号链接，本身不入 git）：`.meshbot/skills/ota-reviews -> ../../tools/ota-reviews`
- Create: `tools/ota-reviews/deploy.sh`（可重复执行的部署脚本，入 git）

- [ ] **Step 1: 写 deploy.sh**

`tools/ota-reviews/deploy.sh`:
```bash
#!/usr/bin/env bash
# 把本 skill 源码挂到 meshbot 运行时 skills 目录（符号链接，幂等）。
# meshbotDir 默认仓库内 .meshbot；可用 MESHBOT_DIR 覆盖。
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"          # tools/ota-reviews 绝对路径
MESHBOT_DIR="${MESHBOT_DIR:-$(cd "$SRC/../../.meshbot" && pwd)}"
DEST="$MESHBOT_DIR/skills/ota-reviews"
mkdir -p "$MESHBOT_DIR/skills"
ln -sfn "$SRC" "$DEST"
echo "linked $DEST -> $SRC"
```

- [ ] **Step 2: 跑 deploy.sh 并确认链接成立**

```bash
cd /Users/grant/Meta1/meshbot
bash tools/ota-reviews/deploy.sh
ls -l .meshbot/skills/ota-reviews
test -f .meshbot/skills/ota-reviews/SKILL.md && echo "SKILL.md reachable via link"
```
Expected: 打印 `linked ...`；`ls -l` 显示符号链接指向 `tools/ota-reviews`；`SKILL.md reachable via link`。

- [ ] **Step 3: 确认符号链接未被 git 跟踪（.meshbot 仍 ignored）**

```bash
git status --short .meshbot/ ; git check-ignore .meshbot/skills/ota-reviews && echo "link ignored (correct)"
```
Expected: `.meshbot/` 下无待提交项；链接被 ignore。

- [ ] **Step 4: 验证 meshbot agent 能发现（若本地 server-agent 在跑）**

让 agent 调 `skill_list`，确认出现 `ota-reviews`；再 `skill_load ota-reviews` 看正文返回、首行带 `[skill dir]`，且 dir 指向链接路径。SkillService 用 `statSync(dir).isDirectory()`（跟随符号链接）+ 读 `SKILL.md`，符号链接目录可被正常识别。若不便联调，跳过——结构正确即可被发现。

- [ ] **Step 5: Commit（只提交 deploy.sh；符号链接不入 git）**

```bash
cd /Users/grant/Meta1/meshbot
chmod +x tools/ota-reviews/deploy.sh
git add tools/ota-reviews/deploy.sh
git commit -m "feat(ota-reviews): 部署脚本（符号链接到 .meshbot/skills）"
```

---

## 自检（plan vs spec）

- **形态/位置**（spec：meshbot skill，每平台一脚本）→ 源码在 tracked 的 `tools/ota-reviews/`（Task 1/8/10/11/12/14），Task 15.5 符号链接部署到 `.meshbot/skills/ota-reviews/` 供 agent 运行时发现。`.meshbot/` gitignored，故源码不放那里。✓
- **手动触发，定时留 Phase 2**（spec）→ Task 14 SKILL.md 写明手动触发；无 schedule 代码。✓
- **统一 Review schema 全字段**（spec 表）→ Task 2 `models.py` 全字段覆盖。✓
- **SQLite + (site,review_id) 去重 + JSON 导出**（spec）→ Task 3/4。✓
- **每平台一脚本 + 共享 common**（spec）→ common 拆成 models/store/targets/runner/fetcher（比单文件 common.py 更聚焦，符合「文件单一职责」）；4 平台脚本 Task 8/10/11/12。✓
- **stealth 抓取 + 代理预留**（spec）→ Task 7 fetcher，`proxy` 参数预留。✓
- **反爬分级 / 封锁标记**（spec）→ Task 11/12 BLOCKED 退出语义 + SKILL.md 标注 best-effort。✓
- **错误处理：部分结果不丢、单站失败不阻断**（spec）→ Task 9 翻页边抓边收集、Task 11/12 单站异常冒泡、agent 逐站跑。注：upsert 是每站抓完一次性写；如需「每页落库」可在 Task 9 scrape 内逐页 upsert，但当前规模（单酒店百条级）一次写足够，遵循 YAGNI。
- **fixture 单测、live 单独可选**（spec）→ Task 8 起每平台 fixture TDD + `-m live` 默认跳过。✓
- **合规：只抓公开页、限速**（spec）→ Task 7 随机延迟 + SKILL.md 注明。✓
- **targets 待填**（spec 开口项）→ Task 5 占位 + Task 13 补全。✓

类型一致性：`Review` 字段、`ReviewStore.upsert/export_json/count/by`、`load_target` 返回 `{url,hotel_name,hotel_key}`、`run(...)` 参数、`parse_reviews(html,*,hotel_key,hotel_name)`、`scrape(target,max_reviews,fetch)` 签名在各 Task 间一致。✓
