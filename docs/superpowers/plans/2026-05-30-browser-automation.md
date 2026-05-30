# 反检测浏览器自动化（browser-agent MCP）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个长驻 stdio MCP server（`tools/browser-agent/`），用 Camoufox 隐身浏览器持有持久登录态 profile，对 meshbot agent 暴露一组与平台无关的低层原语（navigate/snapshot/click/type/extract…），所有交互经人类节奏包装，写操作走「预览→确认」护栏。

**Architecture:** Python `FastMCP` stdio server，进程内常驻一个 `BrowserManager`（单 Camoufox 持久 context + 互斥锁）。MCP 工具 = 薄封装，转调 `primitives.py`；`primitives` 依赖 `humanize.py`（节奏/限速）、`snapshot.py`（页面→精简可访问性树 + ref 映射）、`guardrails.py`（写确认 token）。meshbot 通过 `mcp.json` 的 stdio 条目拉起，核心 agent 零改动。

**Tech Stack:** Python 3.10+ · `mcp`（FastMCP）· `camoufox`（强化版 Firefox，含 Playwright）· `pytest` / `pytest-asyncio`。

参考设计 spec：`docs/superpowers/specs/2026-05-30-browser-automation-design.md`。

---

## 文件结构

```
tools/browser-agent/
├── pyproject.toml              # 依赖 + pytest 配置（markers: browser/online）
├── .gitignore                  # profiles/ debug/ .venv/ __pycache__
├── browser_agent/
│   ├── __init__.py
│   ├── humanize.py             # 纯函数：延迟分布、打字节奏、限速器
│   ├── snapshot.py             # JS 采集脚本 + Python 侧精简/截断格式化（ref 映射）
│   ├── guardrails.py           # WriteGuard：compose→token→confirm 状态机
│   ├── manager.py              # BrowserManager：Camoufox 生命周期 + 持久 profile + 互斥 + 登录
│   ├── primitives.py           # 低层原语实现（依赖上面四个）
│   └── server.py               # FastMCP 入口：把原语注册成 mcp 工具，串行经 manager 锁
├── profiles/                   # 持久 user_data_dir（每账号一个，gitignored）
├── debug/                      # 失败截图（gitignored）
└── tests/
    ├── conftest.py
    ├── test_humanize.py        # 纯单测（默认）
    ├── test_snapshot.py        # 纯单测（默认）
    ├── test_guardrails.py      # 纯单测（默认）
    ├── fixtures/form.html      # 本地静态页（无网络）
    ├── test_primitives.py      # 浏览器集成（@pytest.mark.browser，无网络）
    └── test_stealth.py         # 反检测验收（@pytest.mark.online，opt-in）
```

**测试分层**（对齐 spec「默认不打网络」）：
- 默认套件：`humanize` / `snapshot` 格式化 / `guardrails` —— 纯逻辑，无浏览器、无网络。
- `@pytest.mark.browser`：原语对本地 `file://` fixture 跑真浏览器，**无网络**，但需 camoufox 二进制。
- `@pytest.mark.online`：bot 检测页验收，**需联网**，手动 opt-in。

---

## Task 0：脚手架

**Files:**
- Create: `tools/browser-agent/pyproject.toml`
- Create: `tools/browser-agent/.gitignore`
- Create: `tools/browser-agent/browser_agent/__init__.py`
- Create: `tools/browser-agent/tests/conftest.py`

- [ ] **Step 1: 写 `pyproject.toml`**

```toml
[project]
name = "browser-agent"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "mcp>=1.10",
    "camoufox[geoip]>=0.4",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.24"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
markers = [
    "browser: 需要 camoufox 浏览器二进制，无网络",
    "online: 需要联网（反检测验收），手动 opt-in",
]
addopts = "-m 'not browser and not online'"
testpaths = ["tests"]
```

- [ ] **Step 2: 写 `.gitignore`**

```gitignore
.venv/
__pycache__/
*.pyc
profiles/
debug/
```

- [ ] **Step 3: 建空包文件**

`tools/browser-agent/browser_agent/__init__.py`：
```python
"""browser-agent：反检测浏览器自动化 MCP server。"""
```

- [ ] **Step 4: 写 `tests/conftest.py`**

```python
import sys
from pathlib import Path

# 让测试能 import browser_agent（venv 安装前也可跑纯单测）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
```

- [ ] **Step 5: 建 venv 并安装**

Run:
```bash
cd tools/browser-agent
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m camoufox fetch
```
Expected: 安装成功；`camoufox fetch` 下载强化 Firefox 构建（首次较慢）。

- [ ] **Step 6: 验证空套件可跑**

Run: `.venv/bin/pytest -q`
Expected: `no tests ran`（0 失败）。

- [ ] **Step 7: Commit**

```bash
git add tools/browser-agent/pyproject.toml tools/browser-agent/.gitignore \
        tools/browser-agent/browser_agent/__init__.py tools/browser-agent/tests/conftest.py
git commit -m "chore(browser-agent): 脚手架（pyproject + 包结构 + pytest 分层）"
```

---

## Task 1：`humanize.py`（人类节奏，纯函数）

**Files:**
- Create: `tools/browser-agent/browser_agent/humanize.py`
- Test: `tools/browser-agent/tests/test_humanize.py`

- [ ] **Step 1: 写失败测试**

`tests/test_humanize.py`：
```python
import time
import pytest
from browser_agent.humanize import (
    action_delay, typing_intervals, RateLimiter,
)


def test_action_delay_within_bounds():
    for _ in range(200):
        d = action_delay(lo=0.4, hi=1.5)
        assert 0.4 <= d <= 1.5


def test_action_delay_varies():
    vals = {round(action_delay(0.4, 1.5), 4) for _ in range(50)}
    assert len(vals) > 10  # 非常量、有抖动


def test_typing_intervals_length_and_bounds():
    iv = typing_intervals("hello")
    assert len(iv) == len("hello")
    assert all(0.02 <= x <= 0.5 for x in iv)


def test_rate_limiter_blocks_when_over_budget():
    rl = RateLimiter(max_per_window=2, window_s=10.0, _now=lambda: 100.0)
    assert rl.allow("x.com") is True
    assert rl.allow("x.com") is True
    assert rl.allow("x.com") is False  # 第三次超预算


def test_rate_limiter_separate_keys():
    rl = RateLimiter(max_per_window=1, window_s=10.0, _now=lambda: 100.0)
    assert rl.allow("x.com") is True
    assert rl.allow("xhs.com") is True  # 不同站独立预算
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/test_humanize.py -q`
Expected: FAIL（`ModuleNotFoundError` / 函数未定义）。

- [ ] **Step 3: 实现 `humanize.py`**

```python
"""人类节奏：动作延迟、打字间隔、限速。纯函数 / 可注入时钟，便于单测。"""
from __future__ import annotations

import math
import random
from collections import deque
from typing import Callable, Deque, Dict


def action_delay(lo: float = 0.4, hi: float = 1.5) -> float:
    """两次动作间的随机延迟（秒），偏向区间中段的对数正态抖动。"""
    mu = (math.log(lo) + math.log(hi)) / 2
    sigma = (math.log(hi) - math.log(lo)) / 4
    val = math.exp(random.gauss(mu, sigma))
    return max(lo, min(hi, val))


def typing_intervals(text: str, base: float = 0.08) -> list[float]:
    """逐字输入的间隔列表，模拟人类打字节奏（含偶发停顿）。"""
    out: list[float] = []
    for ch in text:
        jitter = random.uniform(0.6, 1.6)
        pause = 0.25 if ch == " " and random.random() < 0.2 else 0.0
        out.append(min(0.5, max(0.02, base * jitter + pause)))
    return out


class RateLimiter:
    """滑动窗口限速：每个 key（站点）独立预算。"""

    def __init__(self, max_per_window: int, window_s: float,
                 _now: Callable[[], float] | None = None) -> None:
        import time
        self._max = max_per_window
        self._window = window_s
        self._now = _now or time.monotonic
        self._hits: Dict[str, Deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = self._now()
        dq = self._hits.setdefault(key, deque())
        while dq and now - dq[0] > self._window:
            dq.popleft()
        if len(dq) >= self._max:
            return False
        dq.append(now)
        return True
```

- [ ] **Step 4: 跑测试确认通过**

Run: `.venv/bin/pytest tests/test_humanize.py -q`
Expected: PASS（5 passed）。

- [ ] **Step 5: Commit**

```bash
git add tools/browser-agent/browser_agent/humanize.py tools/browser-agent/tests/test_humanize.py
git commit -m "feat(browser-agent): humanize 人类节奏（延迟/打字/限速）+ 单测"
```

---

## Task 2：`snapshot.py`（页面→精简可访问性树 + ref）

把 snapshot 拆成两半：①浏览器侧 JS 采集脚本（常量字符串，给 manager 注入用）；②Python 侧格式化 + token 截断（纯函数，本任务单测）。JS 给每个可交互元素打 `data-mb-ref`，`click(ref)` 时用 `[data-mb-ref="N"]` 定位。

**Files:**
- Create: `tools/browser-agent/browser_agent/snapshot.py`
- Test: `tools/browser-agent/tests/test_snapshot.py`

- [ ] **Step 1: 写失败测试**

`tests/test_snapshot.py`：
```python
from browser_agent.snapshot import format_snapshot, COLLECT_JS


def test_collect_js_is_nonempty_string():
    assert isinstance(COLLECT_JS, str) and "data-mb-ref" in COLLECT_JS


def test_format_basic_tree():
    raw = [
        {"ref": 1, "role": "textbox", "name": "用户名"},
        {"ref": 2, "role": "button", "name": "登录"},
    ]
    out = format_snapshot(raw, max_bytes=32_000)
    assert "[1] textbox 用户名" in out
    assert "[2] button 登录" in out


def test_format_truncates_to_budget():
    raw = [{"ref": i, "role": "button", "name": "x" * 50} for i in range(2000)]
    out = format_snapshot(raw, max_bytes=4_000)
    assert len(out.encode("utf-8")) <= 4_000
    assert "truncated" in out  # 截断有显式标记，不静默


def test_format_skips_nameless_noninteractive():
    raw = [{"ref": 0, "role": "generic", "name": ""}]
    out = format_snapshot(raw, max_bytes=32_000)
    assert out.strip() == "(no interactive elements)"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/test_snapshot.py -q`
Expected: FAIL（导入错误）。

- [ ] **Step 3: 实现 `snapshot.py`**

```python
"""页面快照：浏览器侧 JS 采集（打 data-mb-ref）+ Python 侧精简/截断。"""
from __future__ import annotations

from typing import Any

# 在页面里执行：给可交互元素打 ref，返回 [{ref, role, name}]。
# role 取 ARIA role 或标签名兜底；name 取可见文本 / aria-label / placeholder。
COLLECT_JS = r"""
() => {
  const INTERACTIVE = new Set(['a','button','input','textarea','select','summary']);
  const out = [];
  let ref = 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
     (el.innerText || '').trim() || el.value || '').slice(0, 120);
  for (const el of document.querySelectorAll('*')) {
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const interactive = INTERACTIVE.has(el.tagName.toLowerCase()) ||
                        el.getAttribute('role') || el.getAttribute('contenteditable') === 'true';
    if (!interactive || !visible(el)) continue;
    ref += 1;
    el.setAttribute('data-mb-ref', String(ref));
    out.push({ ref, role, name: nameOf(el) });
  }
  return out;
}
"""


def format_snapshot(raw: list[dict[str, Any]], max_bytes: int = 32_000) -> str:
    """把采集到的元素列表格式化成给 LLM 的精简文本，按字节预算截断。"""
    lines: list[str] = []
    for el in raw:
        name = (el.get("name") or "").strip()
        role = el.get("role") or "generic"
        if not name and role in ("generic", "div", "span"):
            continue
        lines.append(f'[{el["ref"]}] {role} {name}'.rstrip())
    if not lines:
        return "(no interactive elements)"

    out, used = [], 0
    for ln in lines:
        size = len((ln + "\n").encode("utf-8"))
        if used + size > max_bytes - 32:
            out.append("… (truncated)")
            break
        out.append(ln)
        used += size
    return "\n".join(out)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `.venv/bin/pytest tests/test_snapshot.py -q`
Expected: PASS（4 passed）。

- [ ] **Step 5: Commit**

```bash
git add tools/browser-agent/browser_agent/snapshot.py tools/browser-agent/tests/test_snapshot.py
git commit -m "feat(browser-agent): snapshot 采集 JS + 精简/截断格式化 + 单测"
```

---

## Task 3：`guardrails.py`（写操作 compose→confirm 状态机）

**Files:**
- Create: `tools/browser-agent/browser_agent/guardrails.py`
- Test: `tools/browser-agent/tests/test_guardrails.py`

- [ ] **Step 1: 写失败测试**

`tests/test_guardrails.py`：
```python
import pytest
from browser_agent.guardrails import WriteGuard, GuardError


def test_confirm_requires_prior_compose():
    g = WriteGuard(_token=lambda: "tok-1")
    with pytest.raises(GuardError):
        g.confirm("tok-1")  # 没 compose 过，拒绝


def test_compose_then_confirm_ok():
    g = WriteGuard(_token=lambda: "tok-1")
    tok = g.stage(site="x.com", summary="发推：hello")
    assert tok == "tok-1"
    staged = g.confirm(tok)  # 成功，返回暂存信息
    assert staged.summary == "发推：hello"


def test_token_single_use():
    g = WriteGuard(_token=lambda: "tok-1")
    tok = g.stage(site="x.com", summary="x")
    g.confirm(tok)
    with pytest.raises(GuardError):
        g.confirm(tok)  # 用过即失效


def test_wrong_token_rejected():
    g = WriteGuard(_token=lambda: "tok-1")
    g.stage(site="x.com", summary="x")
    with pytest.raises(GuardError):
        g.confirm("not-the-token")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/test_guardrails.py -q`
Expected: FAIL（导入错误）。

- [ ] **Step 3: 实现 `guardrails.py`**

```python
"""写操作护栏：不可逆动作必须先 stage（compose），拿 token，再 confirm 才放行。"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Callable


class GuardError(RuntimeError):
    """护栏拒绝：未 compose / token 错误 / token 已用。"""


@dataclass
class Staged:
    site: str
    summary: str


class WriteGuard:
    def __init__(self, _token: Callable[[], str] | None = None) -> None:
        self._gen = _token or (lambda: uuid.uuid4().hex)
        self._pending: dict[str, Staged] = {}

    def stage(self, *, site: str, summary: str) -> str:
        """暂存一个待确认的不可逆写操作，返回 confirm_token。"""
        tok = self._gen()
        self._pending[tok] = Staged(site=site, summary=summary)
        return tok

    def confirm(self, token: str) -> Staged:
        """校验并消费 token；非法则抛 GuardError。"""
        staged = self._pending.pop(token, None)
        if staged is None:
            raise GuardError("无效或已使用的 confirm_token；不可逆写操作必须先 compose 预览")
        return staged
```

- [ ] **Step 4: 跑测试确认通过**

Run: `.venv/bin/pytest tests/test_guardrails.py -q`
Expected: PASS（4 passed）。

- [ ] **Step 5: Commit**

```bash
git add tools/browser-agent/browser_agent/guardrails.py tools/browser-agent/tests/test_guardrails.py
git commit -m "feat(browser-agent): guardrails 写操作 compose→confirm 状态机 + 单测"
```

---

## Task 4：`manager.py`（Camoufox 生命周期 + 持久 profile + 互斥）

`BrowserManager` 持有 Camoufox 持久 context，串行化所有操作（`asyncio.Lock`）。本任务对**可纯测**的部分（profile 路径解析、锁串行化）写单测；真实浏览器启停放进 Task 6 的 `@pytest.mark.browser` 集成测。

**Files:**
- Create: `tools/browser-agent/browser_agent/manager.py`
- Test: `tools/browser-agent/tests/test_manager.py`

- [ ] **Step 1: 写失败测试**

`tests/test_manager.py`：
```python
import asyncio
from pathlib import Path
import pytest
from browser_agent.manager import BrowserManager, profile_dir


def test_profile_dir_under_base(tmp_path):
    p = profile_dir(tmp_path, "my-x")
    assert p == tmp_path / "my-x"
    assert p.parent == tmp_path


def test_profile_dir_rejects_traversal(tmp_path):
    with pytest.raises(ValueError):
        profile_dir(tmp_path, "../evil")


async def test_run_serializes_calls(tmp_path):
    mgr = BrowserManager(profiles_root=tmp_path, headless=True)
    order: list[str] = []

    async def op(tag, delay):
        order.append(f"start-{tag}")
        await asyncio.sleep(delay)
        order.append(f"end-{tag}")
        return tag

    # 并发提交两个；锁保证不交错
    r = await asyncio.gather(mgr.run(lambda: op("a", 0.05)),
                             mgr.run(lambda: op("b", 0.0)))
    assert r == ["a", "b"]
    assert order == ["start-a", "end-a", "start-b", "end-b"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/test_manager.py -q`
Expected: FAIL（导入错误）。

- [ ] **Step 3: 实现 `manager.py`**

```python
"""BrowserManager：常驻 Camoufox 持久 context + 互斥串行 + profile/登录。"""
from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Awaitable, Callable, TypeVar

from camoufox.async_api import AsyncCamoufox

T = TypeVar("T")


def profile_dir(root: Path, name: str) -> Path:
    """解析账号 profile 目录，拒绝路径穿越。"""
    if "/" in name or "\\" in name or name in ("", ".", ".."):
        raise ValueError(f"非法 profile 名: {name!r}")
    return root / name


class BrowserManager:
    def __init__(self, *, profiles_root: Path, headless: bool = False) -> None:
        self._root = Path(profiles_root)
        self._headless = headless
        self._lock = asyncio.Lock()
        self._stack: AsyncExitStack | None = None
        self._context = None  # camoufox 持久 BrowserContext
        self._profile: str | None = None

    async def run(self, op: Callable[[], Awaitable[T]]) -> T:
        """串行执行一个异步操作（所有原语都经此，保证不并发点乱页面）。"""
        async with self._lock:
            return await op()

    async def ensure_profile(self, name: str) -> None:
        """确保指定 profile 的持久 context 已启动；切换 profile 会重启浏览器。"""
        if self._profile == name and self._context is not None:
            return
        await self.close()
        path = profile_dir(self._root, name)
        path.mkdir(parents=True, exist_ok=True)
        self._stack = AsyncExitStack()
        self._context = await self._stack.enter_async_context(
            AsyncCamoufox(
                headless=self._headless,
                humanize=True,
                persistent_context=True,
                user_data_dir=str(path),
            )
        )
        self._profile = name

    async def page(self):
        """返回当前活动页面（无则新建）。"""
        if self._context is None:
            raise RuntimeError("尚未 use_profile / ensure_profile")
        pages = self._context.pages
        return pages[0] if pages else await self._context.new_page()

    async def close(self) -> None:
        if self._stack is not None:
            await self._stack.aclose()
        self._stack = None
        self._context = None
        self._profile = None
```

- [ ] **Step 4: 跑测试确认通过**

Run: `.venv/bin/pytest tests/test_manager.py -q`
Expected: PASS（3 passed；浏览器启停部分未触发）。

- [ ] **Step 5: Commit**

```bash
git add tools/browser-agent/browser_agent/manager.py tools/browser-agent/tests/test_manager.py
git commit -m "feat(browser-agent): BrowserManager 持久 context + 互斥串行 + profile 解析 + 单测"
```

---

## Task 5：`primitives.py`（低层原语，对 page 操作）

每个原语是「`humanize` 节奏 + Playwright page 调用」的薄封装，接收 `page` 与参数。本任务先写实现 + 本地 fixture 集成测（`@pytest.mark.browser`，无网络）。

**Files:**
- Create: `tools/browser-agent/browser_agent/primitives.py`
- Create: `tools/browser-agent/tests/fixtures/form.html`
- Test: `tools/browser-agent/tests/test_primitives.py`

- [ ] **Step 1: 写本地 fixture**

`tests/fixtures/form.html`：
```html
<!doctype html>
<html><head><meta charset="utf-8"><title>fixture</title></head>
<body>
  <h1>登录</h1>
  <input id="user" placeholder="用户名">
  <button id="go" onclick="document.getElementById('msg').innerText='clicked'">登录</button>
  <p id="msg"></p>
  <ul id="comments"><li class="c">很好</li><li class="c">一般</li></ul>
</body></html>
```

- [ ] **Step 2: 写失败的集成测试**

`tests/test_primitives.py`：
```python
from pathlib import Path
import pytest
from camoufox.async_api import AsyncCamoufox
from browser_agent import primitives as P
from browser_agent.snapshot import COLLECT_JS, format_snapshot

FIXTURE = (Path(__file__).parent / "fixtures" / "form.html").resolve().as_uri()


@pytest.mark.browser
async def test_navigate_and_snapshot_have_refs():
    async with AsyncCamoufox(headless=True, humanize=True) as browser:
        page = await browser.new_page()
        await P.navigate(page, FIXTURE)
        snap = await P.snapshot(page)
        assert "登录" in snap          # button name
        assert "[" in snap             # 含 ref 编号


@pytest.mark.browser
async def test_type_and_click_changes_dom():
    async with AsyncCamoufox(headless=True, humanize=True) as browser:
        page = await browser.new_page()
        await P.navigate(page, FIXTURE)
        await page.evaluate(COLLECT_JS)  # 打 ref
        # user 输入框是第一个可交互元素 → 由 snapshot 决定 ref；这里直接按属性定位验证 type/click
        await page.fill('#user', '')
        await P.type_text(page, ref=_ref_of(await page, 'user'), text='alice')
        assert await page.input_value('#user') == 'alice'


def _ref_of(page, element_id):
    # 测试辅助：读元素已打的 data-mb-ref（COLLECT_JS 执行后）
    return page  # 占位，见下方真正实现的 helper
```

> 注：上面的 `_ref_of` 只是占位，Step 3 实现后用真正的 helper 替换。先让文件存在以跑“收集失败”。

- [ ] **Step 3: 实现 `primitives.py`**

```python
"""低层原语：对 Playwright page 的薄封装，每个交互前后加人类节奏。"""
from __future__ import annotations

import asyncio
from typing import Any

from .humanize import action_delay, typing_intervals
from .snapshot import COLLECT_JS, format_snapshot

_NAV_TIMEOUT = 30_000
_BLOCK_MARKERS = ("captcha", "verify you are human", "请完成安全验证",
                  "checking your browser", "access denied")


def _sel(ref: int) -> str:
    return f'[data-mb-ref="{ref}"]'


async def navigate(page, url: str) -> dict[str, Any]:
    await page.goto(url, wait_until="domcontentloaded", timeout=_NAV_TIMEOUT)
    await asyncio.sleep(action_delay(0.6, 1.8))
    return await get_state(page)


async def get_state(page) -> dict[str, Any]:
    title = await page.title()
    body = (await page.inner_text("body"))[:4000].lower()
    blocked = any(m in body for m in _BLOCK_MARKERS)
    return {"ok": True, "url": page.url, "title": title, "blocked": blocked}


async def snapshot(page, max_bytes: int = 32_000) -> str:
    raw = await page.evaluate(COLLECT_JS)
    return format_snapshot(raw, max_bytes=max_bytes)


async def click(page, ref: int, *, button: str = "left", clicks: int = 1) -> dict[str, Any]:
    loc = page.locator(_sel(ref))
    await loc.scroll_into_view_if_needed(timeout=5000)
    await asyncio.sleep(action_delay(0.3, 1.0))
    await loc.click(button=button, click_count=clicks, timeout=5000)
    await asyncio.sleep(action_delay(0.3, 1.0))
    return {"ok": True}


async def type_text(page, ref: int, text: str, *, submit: bool = False) -> dict[str, Any]:
    loc = page.locator(_sel(ref))
    await loc.scroll_into_view_if_needed(timeout=5000)
    await loc.click(timeout=5000)
    for ch, iv in zip(text, typing_intervals(text)):
        await loc.press_sequentially(ch, delay=0)
        await asyncio.sleep(iv)
    if submit:
        await loc.press("Enter")
    await asyncio.sleep(action_delay(0.3, 1.0))
    return {"ok": True}


async def fill(page, ref: int, text: str) -> dict[str, Any]:
    await page.locator(_sel(ref)).fill(text, timeout=5000)
    return {"ok": True}


async def scroll(page, *, dy: int = 600) -> dict[str, Any]:
    await page.mouse.wheel(0, dy)
    await asyncio.sleep(action_delay(0.4, 1.2))
    return {"ok": True}


async def extract(page, selector: str, fields: dict[str, str] | None = None) -> dict[str, Any]:
    """抽取匹配 selector 的元素文本（fields: 子选择器→字段名），返回原始结构化数据。"""
    items = await page.eval_on_selector_all(
        selector,
        """(els, fields) => els.map(el => {
            if (!fields) return { text: (el.innerText||'').trim() };
            const row = {};
            for (const [k, sub] of Object.entries(fields)) {
                const c = el.querySelector(sub);
                row[k] = c ? (c.innerText||'').trim() : null;
            }
            return row;
        })""",
        fields,
    )
    return {"ok": True, "count": len(items), "data": items}
```

- [ ] **Step 4: 用真实 helper 替换测试里的占位**

把 `tests/test_primitives.py` 末尾的 `_ref_of` 占位替换为：
```python
async def _ref_of(page, element_id):
    return await page.get_attribute(f'#{element_id}', 'data-mb-ref')
```
并把 `test_type_and_click_changes_dom` 改为 `await P.type_text(page, ref=await _ref_of(page, 'user'), text='alice')`（去掉 `await page` 误写）。

- [ ] **Step 5: 跑集成测试（需浏览器，无网络）**

Run: `.venv/bin/pytest tests/test_primitives.py -m browser -q`
Expected: PASS（2 passed）。若报找不到浏览器：先 `.venv/bin/python -m camoufox fetch`。

- [ ] **Step 6: Commit**

```bash
git add tools/browser-agent/browser_agent/primitives.py \
        tools/browser-agent/tests/test_primitives.py tools/browser-agent/tests/fixtures/form.html
git commit -m "feat(browser-agent): primitives 低层原语（navigate/snapshot/click/type/extract…）+ 本地 fixture 集成测"
```

---

## Task 6：`server.py`（FastMCP 工具注册 + manager 串行）

把原语注册成 MCP 工具，全部经 `manager.run(...)` 串行，并接入 `WriteGuard` 与 profile/登录工具。

**Files:**
- Create: `tools/browser-agent/browser_agent/server.py`

- [ ] **Step 1: 实现 `server.py`**

```python
"""browser-agent MCP server：FastMCP 暴露低层原语，全部经 BrowserManager 串行。"""
from __future__ import annotations

import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from . import primitives as P
from .guardrails import WriteGuard
from .manager import BrowserManager

PROFILES_ROOT = Path(__file__).resolve().parent.parent / "profiles"
HEADLESS = os.environ.get("BROWSER_AGENT_HEADLESS", "0") == "1"

mcp = FastMCP("browser")
_mgr = BrowserManager(profiles_root=PROFILES_ROOT, headless=HEADLESS)
_guard = WriteGuard()


@mcp.tool()
async def use_profile(name: str) -> str:
    """切换/启动指定账号的持久隐身 profile（首次需 begin_login 登录）。"""
    await _mgr.ensure_profile(name)
    return f"profile={name} ready (headless={HEADLESS})"


@mcp.tool()
async def begin_login(url: str) -> str:
    """打开登录页，由用户在弹出的浏览器窗口中人工完成登录（2FA/扫码均可）。"""
    async def op():
        page = await _mgr.page()
        return await P.navigate(page, url)
    st = await _mgr.run(op)
    return f"已打开 {st['url']}，请在浏览器窗口完成登录后再继续操作。"


@mcp.tool()
async def navigate(url: str) -> dict:
    """导航到 url，返回页面状态（含是否疑似被反爬挡 blocked）。"""
    return await _mgr.run(lambda: _nav(url))


async def _nav(url: str) -> dict:
    page = await _mgr.page()
    return await P.navigate(page, url)


@mcp.tool()
async def snapshot() -> str:
    """返回当前页精简可访问性树（每个可交互元素带 [ref]，供 click/type 引用）。"""
    return await _mgr.run(lambda: _snap())


async def _snap() -> str:
    page = await _mgr.page()
    return await P.snapshot(page)


@mcp.tool()
async def click(ref: int) -> dict:
    """点击 snapshot 中编号为 ref 的元素。"""
    return await _mgr.run(lambda: _click(ref))


async def _click(ref: int) -> dict:
    page = await _mgr.page()
    return await P.click(page, ref)


@mcp.tool()
async def type_text(ref: int, text: str, submit: bool = False) -> dict:
    """在 ref 元素中逐字输入 text；submit=True 时回车提交。"""
    return await _mgr.run(lambda: _type(ref, text, submit))


async def _type(ref: int, text: str, submit: bool) -> dict:
    page = await _mgr.page()
    return await P.type_text(page, ref, text, submit=submit)


@mcp.tool()
async def extract(selector: str, fields: dict | None = None) -> dict:
    """抽取匹配 selector 的元素文本/字段（看评论用）。大结果建议落盘后再读。"""
    return await _mgr.run(lambda: _extract(selector, fields))


async def _extract(selector: str, fields: dict | None) -> dict:
    page = await _mgr.page()
    return await P.extract(page, selector, fields)


@mcp.tool()
async def get_state() -> dict:
    """当前 url/title 与是否疑似被挡。"""
    return await _mgr.run(lambda: _state())


async def _state() -> dict:
    page = await _mgr.page()
    return await P.get_state(page)


@mcp.tool()
async def compose(site: str, summary: str) -> dict:
    """暂存一个不可逆写操作（如发帖），返回预览与 confirm_token；不会真正发布。"""
    token = _guard.stage(site=site, summary=summary)
    return {"ok": True, "confirm_token": token, "preview": summary,
            "note": "请把预览呈现给用户确认后，再调 confirm_publish(token)。"}


@mcp.tool()
async def confirm_publish(confirm_token: str, publish_ref: int) -> dict:
    """用户确认后，校验 token 并点击 publish_ref 真正发布。"""
    staged = _guard.confirm(confirm_token)  # 非法 token 抛错
    return await _mgr.run(lambda: _publish(publish_ref, staged.summary))


async def _publish(publish_ref: int, summary: str) -> dict:
    page = await _mgr.page()
    await P.click(page, publish_ref)
    return {"ok": True, "published": summary}


def main() -> None:
    mcp.run()  # 默认 stdio transport


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 冒烟：server 能 import 且工具已注册**

Run:
```bash
.venv/bin/python -c "from browser_agent.server import mcp; import asyncio; \
print(sorted(t.name for t in asyncio.run(mcp.list_tools())))"
```
Expected: 打印工具名列表，含 `navigate snapshot click type_text extract compose confirm_publish use_profile begin_login get_state`。

- [ ] **Step 3: Commit**

```bash
git add tools/browser-agent/browser_agent/server.py
git commit -m "feat(browser-agent): FastMCP server 注册原语 + 串行 + 写护栏工具"
```

---

## Task 7：接入 meshbot `mcp.json` + 安装文档

**Files:**
- Create: `tools/browser-agent/README.md`

- [ ] **Step 1: 写 `README.md`**（含安装与 mcp.json 接线）

````markdown
# browser-agent

反检测浏览器自动化 MCP server（Camoufox + 持久登录态 profile + LLM 驱动低层原语）。
设计见 `docs/superpowers/specs/2026-05-30-browser-automation-design.md`。

## 安装
```bash
cd tools/browser-agent
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m camoufox fetch
```

## 接入 meshbot
在 `<meshbotDir>/mcp.json` 的 `servers` 加一条（stdio）：
```json
{
  "servers": {
    "browser": {
      "command": "/ABS/PATH/meshbot/tools/browser-agent/.venv/bin/python",
      "args": ["-m", "browser_agent.server"],
      "env": { "BROWSER_AGENT_HEADLESS": "0" }
    }
  }
}
```
重启 server-agent 后，agent 会拿到 `mcp__browser__*` 工具。

## 首次登录
让 agent 调 `use_profile("my-x")` → `begin_login("https://x.com/login")`，在弹出的窗口里人工登录；
之后会话持久复用。`BROWSER_AGENT_HEADLESS=1` 可无头运行（隐蔽性略降）。

## 测试
```bash
.venv/bin/pytest -q                 # 纯单测（默认，无网络无浏览器）
.venv/bin/pytest -m browser -q      # 原语集成（需 camoufox 二进制，无网络）
.venv/bin/pytest -m online -q       # 反检测验收（需联网，opt-in）
```
````

- [ ] **Step 2: 校验 mcp.json schema 字段**

读 `libs/agent/src/mcp/mcp.schema.ts` 确认 stdio 条目字段名（`command`/`args`/`env`）与上面一致。
Run: `grep -nE "command|args|env|url|transport" libs/agent/src/mcp/mcp.schema.ts`
Expected: 字段名匹配；如不一致，按实际 schema 改 README 的 JSON。

- [ ] **Step 3: Commit**

```bash
git add tools/browser-agent/README.md
git commit -m "docs(browser-agent): 安装 + mcp.json 接入 + 测试说明"
```

---

## Task 8：反检测验收测试（opt-in，需联网）

**Files:**
- Create: `tools/browser-agent/tests/test_stealth.py`

- [ ] **Step 1: 写验收测试**

`tests/test_stealth.py`：
```python
import pytest
from camoufox.async_api import AsyncCamoufox


@pytest.mark.online
async def test_no_webdriver_flag():
    async with AsyncCamoufox(headless=True, humanize=True) as browser:
        page = await browser.new_page()
        await page.goto("https://bot.sannysoft.com/", wait_until="networkidle", timeout=60000)
        wd = await page.evaluate("() => navigator.webdriver")
        assert wd in (False, None, "false")


@pytest.mark.online
async def test_sannysoft_no_red_failures():
    async with AsyncCamoufox(headless=True, humanize=True) as browser:
        page = await browser.new_page()
        await page.goto("https://bot.sannysoft.com/", wait_until="networkidle", timeout=60000)
        # 该页对失败项用 class="failed" 标红；断言关键项无 failed
        failed = await page.eval_on_selector_all(
            ".failed", "els => els.map(e => e.id || e.className)"
        )
        assert "webdriver" not in " ".join(failed).lower()
```

- [ ] **Step 2: 跑验收（手动 opt-in）**

Run: `.venv/bin/pytest tests/test_stealth.py -m online -q`
Expected: PASS。**这是“不被检测”的可量化达标线**（spec §测试）。若红，调 `humanize`/Camoufox `os=` 指纹参数再验。

- [ ] **Step 3: Commit**

```bash
git add tools/browser-agent/tests/test_stealth.py
git commit -m "test(browser-agent): 反检测验收（sannysoft，opt-in online）"
```

---

## 首切片三步验收（手动，对齐 spec §首个垂直切片）

实现完上述任务后，按 spec 三步人工验收：
1. **反检测**：`pytest -m online`（Task 8）通过 → 环境达标。
2. **读链路**：在 agent 里 `use_profile("my-x")` → `begin_login` 登录 X → `navigate` 到自己主页 → `snapshot` → `extract(".comment-selector")` 拉最新一条推评论 → 摘要回 agent。
3. **护栏写链路**：`compose(site="x.com", summary="...")` → 把预览给用户 → 用户确认 → `confirm_publish(token, publish_ref)` 发出。

跨过即闭环；小红书/猫途鹰为同一套原语、零新代码。

---

## Self-Review（计划对 spec 的覆盖）

- 架构/进程模型（长驻 stdio MCP + BrowserManager 串行）→ Task 4、6 ✓
- 完整通用原语面 → Task 5（navigate/snapshot/click/type/fill/scroll/extract/get_state）+ Task 6 注册；`drag/hover/select/tabs/upload/dialog/switch_frame` 为同模式追加项，首切片未列全（YAGNI：验收三步用不到，按需补，模式同 Task 5）✓（已显式标注，非静默裁剪）
- 反检测环境层：Camoufox + humanize + 持久 profile + headed 默认（`BROWSER_AGENT_HEADLESS`）→ Task 1、4、6、8 ✓
- 写护栏 compose→confirm → Task 3、6 ✓
- 错误处理（blocked 标记、超时）→ `get_state` + 各调用 timeout（Task 5）✓；失败截图落 `debug/` 为追加项（同 YAGNI 注记）
- 测试分层（纯单测默认 / browser / online）→ Task 0 markers + 各任务 ✓
- mcp.json 接入 → Task 7 ✓

> 注：首切片刻意只把验收三步必需的原语做全，其余原语（drag/hover/select/tabs/upload/dialog/frame）与失败截图落盘是**已知的追加项**，实现模式与 Task 5 完全一致，按需补，不属于遗漏。
