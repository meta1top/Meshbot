# browser-mcp（自写薄 nodriver stealth MCP）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自写一个十几工具的薄 MCP server（Python，`tools/browser-mcp/`），引擎用 nodriver 驱动系统真 Chrome，对 meshbot agent 暴露通用低层原语（navigate/snapshot/click/type/extract…），登录态持久（移植 RobithYusuf `state.py` 的 profile 鲁棒性），可发 PyPI。

**Architecture:** 独立可发布 Python 包（类比 `tools/ota-reviews`，自带 venv）。`server.py`（FastMCP stdio）→ 全经 `manager.py`（常驻 nodriver 浏览器 + asyncio 串行锁 + 每账号 profile）→ `primitives.py`（对 nodriver tab 的薄封装，内置 `humanize.py` 节奏）。`snapshot.py` 给元素打 ref；`profile.py` 移植 state.py 处理 Chrome SingletonLock/窗口残留；`session.py` 做 storage_state 双轨持久登录；`patches.py` 带 nodriver cookie 补丁。meshbot 经 `mcp.json` stdio 接入，核心零改动。

**Tech Stack:** Python 3.10+ · `nodriver`（CDP attach 真 Chrome，反检测；实测 0.50.3 navigator.webdriver=False）· `mcp`（FastMCP）· `pytest`/`pytest-asyncio`。

参考 spec：`docs/superpowers/specs/2026-05-31-browser-mcp-nodriver-design.md`。

> 已验证 nodriver API：`browser = await uc.start(user_data_dir=, headless=, sandbox=True)` → `tab = await browser.get(url)` → `await tab.evaluate(js)` / `el = await tab.select(css)` / `await el.click()` / `await el.send_keys(text)` / `await tab.get_content()` / `await tab.sleep(s)`；`browser.cookies.get_all()/.save(p)/.load(p)`；`browser.stop()`。

---

## 文件结构

```
tools/browser-mcp/
├── pyproject.toml          # 可发布：name=meshbot-browser-mcp，deps nodriver/mcp，dev pytest/pytest-asyncio
├── .gitignore              # .venv profiles debug __pycache__
├── README.md               # 安装/mcp.json 接入/登录/行为安全纪律
├── browser_mcp/
│   ├── __init__.py
│   ├── humanize.py         # 纯：action_delay/typing_intervals/mouse_path/RateLimiter/sleep
│   ├── snapshot.py         # COLLECT_JS 常量 + format_snapshot（纯，控 32KB）
│   ├── profile.py          # 移植 state.py：profile_dir/读 SingletonLock PID/锁判定/per-PID 回退/wipe_window_state
│   ├── patches.py          # 按需打 nodriver Cookie.from_json 补丁
│   ├── manager.py          # BrowserManager：uc.start 常驻 + asyncio 串行锁 + 每账号 profile + 关停
│   ├── primitives.py       # navigate/get_state/snapshot/click/type_text/fill/scroll/extract
│   └── server.py           # FastMCP：注册 ~12 工具，全经 manager 串行
└── tests/
    ├── fixtures/form.html
    └── *.py                # pytest：纯单测默认；nodriver e2e + 反检测验收用 env 开关 opt-in
```

测试分层：默认 `pytest`（纯单测，无浏览器）；`BROWSER_E2E=1` 跑 nodriver 真 Chrome 集成；`BROWSER_ONLINE=1` 跑反检测验收。pytest.ini 用 `-m "not browser and not online"` 默认排除。

---

## Task 0：脚手架

**Files:** Create `tools/browser-mcp/pyproject.toml`、`.gitignore`、`browser_mcp/__init__.py`、`tests/smoke_test.py`

- [ ] **Step 1: `pyproject.toml`**
```toml
[project]
name = "meshbot-browser-mcp"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["nodriver>=0.50", "mcp>=1.10"]
[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.24"]
[project.scripts]
browser-mcp = "browser_mcp.server:main"
[tool.pytest.ini_options]
asyncio_mode = "auto"
markers = ["browser: 需 nodriver+Chrome，无网络", "online: 需联网（反检测验收）"]
addopts = "-m 'not browser and not online'"
testpaths = ["tests"]
```

- [ ] **Step 2: `.gitignore`**
```gitignore
.venv/
__pycache__/
*.pyc
profiles/
debug/
```

- [ ] **Step 3: `browser_mcp/__init__.py`**
```python
"""meshbot-browser-mcp：自写薄 nodriver stealth MCP。"""
```

- [ ] **Step 4: `tests/smoke_test.py`**
```python
def test_smoke():
    assert 1 + 1 == 2
```

- [ ] **Step 5: venv + 装依赖 + 验证 nodriver/Chrome/stealth**
```bash
cd tools/browser-mcp
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python - <<'PY'
import nodriver as uc, importlib.metadata as m
print("nodriver", m.version("nodriver"))
async def main():
    import tempfile
    b = await uc.start(user_data_dir=tempfile.mkdtemp(), headless=True, sandbox=True)
    t = await b.get("about:blank")
    print("navigator.webdriver =", await t.evaluate("navigator.webdriver"))
    b.stop()
uc.loop().run_until_complete(main())
PY
```
Expected: nodriver 版本打印；`navigator.webdriver = False`（系统 Chrome 自动探测）。缺 Chrome 则 nodriver 报错——README 注明需装 Google Chrome。

- [ ] **Step 6: 空套件**
Run: `cd tools/browser-mcp && .venv/bin/pytest -q` → 1 passed。

- [ ] **Step 7: Commit**
```bash
git add tools/browser-mcp/pyproject.toml tools/browser-mcp/.gitignore tools/browser-mcp/browser_mcp/__init__.py tools/browser-mcp/tests/smoke_test.py
git commit -m "chore(browser-mcp): 脚手架（pyproject + nodriver + pytest）"
```

---

## Task 1：`humanize.py`（行为节奏，纯函数）

**Files:** Create `browser_mcp/humanize.py`、Test `tests/test_humanize.py`

- [ ] **Step 1: 失败测试 `tests/test_humanize.py`**
```python
from browser_mcp.humanize import action_delay, typing_intervals, mouse_path, RateLimiter

def test_action_delay_bounds_and_varies():
    vals = {round(action_delay(0.4, 1.5), 4) for _ in range(200)}
    assert all(0.4 <= v <= 1.5 for v in vals) and len(vals) > 20

def test_typing_intervals():
    iv = typing_intervals("hello")
    assert len(iv) == 5 and all(0.02 <= x <= 0.5 for x in iv)

def test_mouse_path_endpoints():
    p = mouse_path((0, 0), (100, 50), 6)
    assert p[0] == (0, 0) and p[-1] == (100, 50) and len(p) == 7

def test_rate_limiter():
    now = [100.0]
    rl = RateLimiter(1, 10, lambda: now[0])
    assert rl.allow("x") and not rl.allow("x") and rl.allow("y")
    now[0] = 111.0
    assert rl.allow("x")
```

- [ ] **Step 2: 跑红** `cd tools/browser-mcp && .venv/bin/pytest tests/test_humanize.py -q` → FAIL。

- [ ] **Step 3: 实现 `browser_mcp/humanize.py`**
```python
"""行为节奏：动作延迟、打字间隔、鼠标轨迹、限速。纯函数 / 可注入时钟。"""
from __future__ import annotations
import asyncio, math, random, time
from collections import deque
from typing import Callable

def action_delay(lo: float = 0.4, hi: float = 1.5) -> float:
    mu = (math.log(lo) + math.log(hi)) / 2
    sigma = (math.log(hi) - math.log(lo)) / 4
    return max(lo, min(hi, math.exp(random.gauss(mu, sigma))))

def typing_intervals(text: str, base: float = 0.08) -> list[float]:
    out = []
    for ch in text:
        jitter = random.uniform(0.6, 1.6)
        pause = 0.25 if ch == " " and random.random() < 0.2 else 0.0
        out.append(min(0.5, max(0.02, base * jitter + pause)))
    return out

def mouse_path(frm: tuple[float, float], to: tuple[float, float], steps: int = 12) -> list[tuple[float, float]]:
    pts = [(frm[0], frm[1])]
    for i in range(1, steps):
        t = i / steps
        jx = (random.random() - 0.5) * 4
        jy = (random.random() - 0.5) * 4
        pts.append((frm[0] + (to[0] - frm[0]) * t + jx, frm[1] + (to[1] - frm[1]) * t + jy))
    pts.append((to[0], to[1]))
    return pts

class RateLimiter:
    def __init__(self, max_per_window: int, window_s: float, now: Callable[[], float] | None = None):
        self._max, self._window, self._now = max_per_window, window_s, now or time.monotonic
        self._hits: dict[str, deque] = {}

    def allow(self, key: str) -> bool:
        t = self._now()
        dq = self._hits.setdefault(key, deque())
        while dq and t - dq[0] > self._window:
            dq.popleft()
        if len(dq) >= self._max:
            return False
        dq.append(t)
        return True

async def sleep(s: float) -> None:
    await asyncio.sleep(s)
```

- [ ] **Step 4: 跑绿** `.venv/bin/pytest tests/test_humanize.py -q` → 4 passed。

- [ ] **Step 5: Commit** `git add browser_mcp/humanize.py tests/test_humanize.py && git commit -m "feat(browser-mcp): humanize 行为节奏 + 单测"`（在 tools/browser-mcp 下）

---

## Task 2：`snapshot.py`（页面→精简可访问性树 + ref，纯）

**Files:** Create `browser_mcp/snapshot.py`、Test `tests/test_snapshot.py`

- [ ] **Step 1: 失败测试 `tests/test_snapshot.py`**
```python
from browser_mcp.snapshot import COLLECT_JS, format_snapshot

def test_collect_js_const():
    assert isinstance(COLLECT_JS, str) and "data-mb-ref" in COLLECT_JS

def test_format_basic():
    raw = [{"ref": 1, "role": "textbox", "name": "用户名"}, {"ref": 2, "role": "button", "name": "登录"}]
    out = format_snapshot(raw, 32000)
    assert "[1] textbox 用户名" in out and "[2] button 登录" in out

def test_format_truncate():
    raw = [{"ref": i, "role": "button", "name": "x" * 50} for i in range(2000)]
    out = format_snapshot(raw, 4000)
    assert len(out.encode()) <= 4000 and "truncated" in out

def test_format_empty():
    assert format_snapshot([{"ref": 0, "role": "generic", "name": ""}], 32000).strip() == "(no interactive elements)"
```

- [ ] **Step 2: 跑红** → FAIL。

- [ ] **Step 3: 实现 `browser_mcp/snapshot.py`**
```python
"""页面快照：浏览器侧 JS 采集（打 data-mb-ref）+ Python 侧精简/截断。"""
from __future__ import annotations
from typing import Any

# 给可交互+可见元素打 data-mb-ref，返回 [{ref, role, name}]；排除 presentation/none/separator 装饰元素。
COLLECT_JS = r"""
(() => {
  const INTERACTIVE = new Set(['a','button','input','textarea','select','summary']);
  const SKIP = new Set(['presentation','none','separator']);
  const out = []; let ref = 0;
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.value ||
    el.getAttribute('placeholder') || (el.innerText||'').trim() || '').slice(0,120);
  for (const el of document.querySelectorAll('*')) {
    const ar = el.getAttribute('role');
    const interactive = INTERACTIVE.has(el.tagName.toLowerCase()) ||
      (ar && !SKIP.has(ar)) || el.getAttribute('contenteditable')==='true';
    if (!interactive || !vis(el)) continue;
    ref += 1; el.setAttribute('data-mb-ref', String(ref));
    out.push({ ref, role: ar || el.tagName.toLowerCase(), name: nameOf(el) });
  }
  return out;
})()
"""

def format_snapshot(raw: list[dict[str, Any]], max_bytes: int = 32_000) -> str:
    lines = []
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
        size = len((ln + "\n").encode())
        if used + size > max_bytes - 32:
            out.append("… (truncated)")
            break
        out.append(ln); used += size
    return "\n".join(out)
```

- [ ] **Step 4: 跑绿** → 4 passed。
- [ ] **Step 5: Commit** `feat(browser-mcp): snapshot 采集 JS + 精简/截断 + 单测`

---

## Task 3：`profile.py`（移植 RobithYusuf state.py 的 profile 鲁棒性）

**Files:** Create `browser_mcp/profile.py`、Test `tests/test_profile.py`

- [ ] **Step 1: 失败测试 `tests/test_profile.py`**
```python
import os, pytest
from browser_mcp.profile import profile_dir, read_singleton_pid, is_profile_locked, wipe_window_state

def test_profile_dir(tmp_path):
    assert profile_dir(tmp_path, "acct") == tmp_path / "acct"

def test_profile_dir_traversal(tmp_path):
    for bad in ["", ".", "..", "a/b", "a\\b"]:
        with pytest.raises(ValueError):
            profile_dir(tmp_path, bad)

def test_singleton_pid_and_lock(tmp_path):
    # 无锁文件 -> None, 未锁
    assert read_singleton_pid(tmp_path) is None and is_profile_locked(tmp_path) is False
    # 造一个指向陈旧 PID 的 SingletonLock 符号链接（PID 99999999 必不存在）
    link = tmp_path / "SingletonLock"
    os.symlink("somehost-99999999", link)
    assert read_singleton_pid(tmp_path) == 99999999
    assert is_profile_locked(tmp_path) is False  # 陈旧锁 = 未锁

def test_wipe_window_state_keeps_cookies(tmp_path):
    default = tmp_path / "Default"
    default.mkdir(parents=True)
    (default / "Cookies").write_text("KEEP")
    (default / "Current Session").write_text("X")
    (default / "Preferences").write_text('{"profile":{"x":1},"browser":{"window_placement":{"w":0}}}')
    wipe_window_state(tmp_path)
    assert (default / "Cookies").exists()              # 登录态保留
    assert not (default / "Current Session").exists()  # 会话残留清掉
    import json
    prefs = json.loads((default / "Preferences").read_text())
    assert "window_placement" not in prefs.get("browser", {})  # 窗口残留清掉
```

- [ ] **Step 2: 跑红** → FAIL。

- [ ] **Step 3: 实现 `browser_mcp/profile.py`**
```python
"""Chrome profile 鲁棒性（移植 RobithYusuf state.py 思路）：
SingletonLock PID 解析、活锁/陈旧锁判定、窗口残留清理（保留登录态）。"""
from __future__ import annotations
import json, os
from pathlib import Path

def profile_dir(root, name: str) -> Path:
    if "/" in name or "\\" in name or name in ("", ".", ".."):
        raise ValueError(f"非法 profile 名: {name!r}")
    return Path(root) / name

def read_singleton_pid(profile: Path) -> int | None:
    """读 <profile>/SingletonLock 符号链接里的 PID（形如 host-<pid>）；无则 None。"""
    link = Path(profile) / "SingletonLock"
    try:
        target = os.readlink(link)
    except OSError:
        return None
    tail = target.rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else None

def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def is_profile_locked(profile: Path) -> bool:
    """有 SingletonLock 且其 PID 进程存活 = 被占；陈旧锁（进程已退）视为未锁。"""
    pid = read_singleton_pid(profile)
    return pid is not None and _pid_alive(pid)

def clean_stale_lock(profile: Path) -> None:
    """仅删陈旧锁（进程已退），不动活锁。"""
    pid = read_singleton_pid(profile)
    if pid is not None and not _pid_alive(pid):
        for n in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
            try:
                (Path(profile) / n).unlink()
            except OSError:
                pass

def wipe_window_state(profile: Path) -> None:
    """清窗口/会话残留（治 macOS sleep/wake 后窗口 0×0），保留 cookie/登录/Storage。"""
    default = Path(profile) / "Default"
    for n in ("Current Session", "Last Session", "Current Tabs", "Last Tabs"):
        try:
            (default / n).unlink()
        except OSError:
            pass
    import shutil
    try:
        shutil.rmtree(default / "Sessions", ignore_errors=True)
    except OSError:
        pass
    prefs = default / "Preferences"
    try:
        data = json.loads(prefs.read_text())
        data.get("browser", {}).pop("window_placement", None)
        prefs.write_text(json.dumps(data))
    except (OSError, ValueError):
        pass
```

- [ ] **Step 4: 跑绿** → 4 passed。
- [ ] **Step 5: Commit** `feat(browser-mcp): profile 移植 state.py（SingletonLock/锁判定/窗口清理）+ 单测`

---

## Task 4：`patches.py` + `manager.py`（nodriver 常驻 + 串行 + profile）

**Files:** Create `browser_mcp/patches.py`、`browser_mcp/manager.py`、Test `tests/test_manager.py`

- [ ] **Step 1: 失败测试 `tests/test_manager.py`**
```python
import asyncio, pytest
from browser_mcp.manager import BrowserManager

async def test_run_serializes(tmp_path):
    mgr = BrowserManager(profiles_root=tmp_path, headless=True)
    order = []
    async def op(tag, d):
        order.append(f"s-{tag}"); await asyncio.sleep(d); order.append(f"e-{tag}"); return tag
    r = await asyncio.gather(mgr.run(lambda: op("a", 0.05)), mgr.run(lambda: op("b", 0.0)))
    assert r == ["a", "b"] and order == ["s-a", "e-a", "s-b", "e-b"]

def test_profile_path(tmp_path):
    mgr = BrowserManager(profiles_root=tmp_path, headless=True)
    assert mgr._profile_path("acct") == tmp_path / "acct"
```

- [ ] **Step 2: 跑红** → FAIL。

- [ ] **Step 3: 实现 `browser_mcp/patches.py`**
```python
"""按需为 nodriver 打补丁：某些 nodriver/Chrome 组合下 cdp Cookie.from_json 缺字段会 KeyError。
幂等、防御式：仅当存在该类且其 from_json 会因缺键崩时包一层 setdefault。"""
from __future__ import annotations

def apply() -> None:
    try:
        from nodriver.cdp import network as _net
    except Exception:
        return
    cookie = getattr(_net, "Cookie", None)
    if cookie is None or getattr(cookie, "_mb_patched", False):
        return
    orig = cookie.from_json.__func__ if hasattr(cookie.from_json, "__func__") else cookie.from_json
    def from_json(cls, json):
        json = dict(json)
        for k, d in (("size", 0), ("priority", "Medium"), ("session", False),
                     ("sameParty", False), ("sourceScheme", "Unset"), ("sourcePort", 0)):
            json.setdefault(k, d)
        return orig(cls, json) if hasattr(orig, "__get__") else orig(json)
    try:
        cookie.from_json = classmethod(from_json)
        cookie._mb_patched = True
    except Exception:
        pass
```

- [ ] **Step 4: 实现 `browser_mcp/manager.py`**
```python
"""BrowserManager：常驻 nodriver 真 Chrome + asyncio 串行锁 + 每账号持久 profile。"""
from __future__ import annotations
import asyncio
from pathlib import Path
from typing import Awaitable, Callable, TypeVar
import nodriver as uc
from . import patches, profile as prof

T = TypeVar("T")

class BrowserManager:
    def __init__(self, *, profiles_root, headless: bool = False):
        patches.apply()
        self._root = Path(profiles_root)
        self._headless = headless
        self._lock = asyncio.Lock()
        self._browser = None
        self._profile: str | None = None

    def _profile_path(self, name: str) -> Path:
        return prof.profile_dir(self._root, name)

    async def run(self, op: Callable[[], Awaitable[T]]) -> T:
        async with self._lock:
            return await op()

    async def ensure_profile(self, name: str):
        async with self._lock:
            if self._profile == name and self._browser is not None:
                return
            await self._close_locked()
            path = self._profile_path(name)
            path.mkdir(parents=True, exist_ok=True)
            prof.clean_stale_lock(path)
            prof.wipe_window_state(path)
            self._browser = await uc.start(
                user_data_dir=str(path), headless=self._headless, sandbox=True
            )
            self._profile = name

    async def tab(self):
        if self._browser is None:
            raise RuntimeError("尚未 use_profile")
        return self._browser.main_tab or await self._browser.get("about:blank")

    async def close(self) -> None:
        async with self._lock:
            await self._close_locked()

    async def _close_locked(self) -> None:
        if self._browser is not None:
            try:
                self._browser.stop()
            except Exception:
                pass
        self._browser = None
        self._profile = None
```

- [ ] **Step 5: 跑绿（纯单测，不起浏览器）** `.venv/bin/pytest tests/test_manager.py -q` → 2 passed。

- [ ] **Step 6: e2e 冒烟（起真 Chrome，webdriver 隐藏）**
```bash
.venv/bin/python - <<'PY'
import asyncio, tempfile
from browser_mcp.manager import BrowserManager
async def m():
    mgr = BrowserManager(profiles_root=tempfile.mkdtemp(), headless=True)
    await mgr.ensure_profile("t")
    tab = await mgr.tab(); await tab.get("about:blank")
    print("webdriver:", await tab.evaluate("navigator.webdriver"))
    await mgr.close()
asyncio.run(m())
PY
```
Expected: `webdriver: False`。

- [ ] **Step 7: Commit** `feat(browser-mcp): BrowserManager nodriver 常驻+串行+profile + cookie 补丁 + 测`

---

## Task 5：`primitives.py`（低层原语，对 nodriver tab）

**Files:** Create `browser_mcp/primitives.py`、`tests/fixtures/form.html`、Test `tests/test_primitives.py`

- [ ] **Step 1: fixture `tests/fixtures/form.html`**
```html
<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>登录</h1><input id="u" placeholder="用户名">
<button id="go" onclick="document.getElementById('m').innerText='clicked'">登录</button>
<p id="m"></p><ul><li class="c">很好</li><li class="c">一般</li></ul></body></html>
```

- [ ] **Step 2: e2e 失败测试 `tests/test_primitives.py`**
```python
import os, pytest, tempfile, nodriver as uc
from pathlib import Path
from browser_mcp import primitives as P
from browser_mcp.snapshot import COLLECT_JS

FIX = "file://" + str(Path("tests/fixtures/form.html").resolve())

@pytest.mark.browser
async def test_navigate_snapshot_click_type():
    b = await uc.start(user_data_dir=tempfile.mkdtemp(), headless=True, sandbox=True)
    try:
        tab = await b.get(FIX)
        st = await P.get_state(tab); assert "登录" in st["title"] or st["ok"]
        snap = await P.snapshot(tab); assert "登录" in snap and "[" in snap
        await tab.evaluate(COLLECT_JS)
        uref = await tab.evaluate("document.getElementById('u').getAttribute('data-mb-ref')")
        await P.type_text(tab, uref, "alice")
        assert (await tab.evaluate("document.getElementById('u').value")) == "alice"
        gref = await tab.evaluate("document.getElementById('go').getAttribute('data-mb-ref')")
        await P.click(tab, gref)
        await tab.sleep(0.3)
        assert (await tab.evaluate("document.getElementById('m').innerText")) == "clicked"
        res = await P.extract(tab, ".c")
        assert res["count"] == 2 and res["data"][0]["text"] == "很好"
    finally:
        b.stop()
```

- [ ] **Step 3: 跑红（e2e）** `BROWSER_E2E=1 .venv/bin/pytest tests/test_primitives.py -q` → FAIL（import）。

- [ ] **Step 4: 实现 `browser_mcp/primitives.py`**
```python
"""低层原语：对 nodriver tab 的薄封装，交互内置人类节奏。元素用 data-mb-ref 定位。"""
from __future__ import annotations
from typing import Any
from .humanize import action_delay, typing_intervals, sleep
from .snapshot import COLLECT_JS, format_snapshot

_BLOCK = ("captcha", "verify you are human", "are you a robot", "access denied",
          "checking your browser", "请完成安全验证", "请稍候")

def _sel(ref) -> str:
    return f'[data-mb-ref="{ref}"]'

async def navigate(tab, url: str) -> dict[str, Any]:
    await tab.get(url)
    await sleep(action_delay(0.6, 1.8))
    return await get_state(tab)

async def get_state(tab) -> dict[str, Any]:
    title = await tab.evaluate("document.title")
    try:
        body = (await tab.evaluate("document.body ? document.body.innerText.slice(0,4000) : ''")) or ""
    except Exception:
        body = ""
    blocked = any(m in body.lower() for m in _BLOCK)
    url = await tab.evaluate("location.href")
    return {"ok": True, "url": url, "title": title or "", "blocked": blocked}

async def snapshot(tab, max_bytes: int = 32_000) -> str:
    raw = await tab.evaluate(COLLECT_JS, return_by_value=True)
    return format_snapshot(raw or [], max_bytes)

async def click(tab, ref) -> dict[str, Any]:
    el = await tab.select(_sel(ref))
    await sleep(action_delay(0.3, 1.0))
    await el.click()
    await sleep(action_delay(0.3, 1.0))
    return {"ok": True}

async def type_text(tab, ref, text: str, submit: bool = False) -> dict[str, Any]:
    el = await tab.select(_sel(ref))
    await el.click()
    iv = typing_intervals(text)
    for i, ch in enumerate(text):
        await el.send_keys(ch)
        await sleep(iv[i] if i < len(iv) else 0.05)
    if submit:
        await el.send_keys("\r")
    await sleep(action_delay(0.3, 1.0))
    return {"ok": True}

async def fill(tab, ref, text: str) -> dict[str, Any]:
    el = await tab.select(_sel(ref))
    el.clear_input()
    await el.send_keys(text)
    return {"ok": True}

async def scroll(tab, dy: int = 600) -> dict[str, Any]:
    await tab.evaluate(f"window.scrollBy(0,{dy})")
    await sleep(action_delay(0.4, 1.2))
    return {"ok": True}

async def extract(tab, selector: str) -> dict[str, Any]:
    js = ("(()=>Array.from(document.querySelectorAll(" + repr(selector) +
          ")).map(e=>({text:(e.innerText||'').trim()})))()")
    items = await tab.evaluate(js, return_by_value=True) or []
    return {"ok": True, "count": len(items), "data": items}
```

- [ ] **Step 5: 跑绿（e2e）** `BROWSER_E2E=1 .venv/bin/pytest tests/test_primitives.py -q` → 1 passed。若 `return_by_value` 参数名不符已装 nodriver，按实际签名调整（实现者用 `.venv/bin/python -c "import inspect,nodriver;print(inspect.signature(nodriver.Tab.evaluate))"` 核对）。
- [ ] **Step 6: Commit** `feat(browser-mcp): primitives 低层原语 + 本地 fixture e2e`

---

## Task 6：`server.py`（FastMCP 注册 ~12 工具）

**Files:** Create `browser_mcp/server.py`、Test `tests/test_server.py`

- [ ] **Step 1: 失败测试 `tests/test_server.py`**
```python
import asyncio
from browser_mcp.server import mcp
EXPECTED = {"use_profile","navigate","snapshot","click","type_text","fill","scroll",
            "extract","get_state","cookies_save","cookies_load","screenshot"}
def test_tools_registered():
    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert EXPECTED.issubset(names)
```

- [ ] **Step 2: 跑红** → FAIL。

- [ ] **Step 3: 实现 `browser_mcp/server.py`**
```python
"""browser-mcp：FastMCP 暴露通用低层原语，全经 BrowserManager 串行。"""
from __future__ import annotations
import os
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from . import primitives as P
from .manager import BrowserManager

PROFILES_ROOT = Path(__file__).resolve().parent.parent / "profiles"
HEADLESS = os.environ.get("BROWSER_MCP_HEADLESS", "0") == "1"

mcp = FastMCP("browser")
_mgr = BrowserManager(profiles_root=PROFILES_ROOT, headless=HEADLESS)

@mcp.tool()
async def use_profile(name: str) -> str:
    """启动/切换某账号的持久隐身 profile（首次需在弹出的 Chrome 里人工登录）。"""
    await _mgr.ensure_profile(name)
    return f"profile={name} ready (headless={HEADLESS})"

async def _t():
    return await _mgr.tab()

@mcp.tool()
async def navigate(url: str) -> dict:
    """导航到 url，返回状态（含是否疑似被挡）。"""
    return await _mgr.run(lambda: _nav(url))
async def _nav(url): return await P.navigate(await _t(), url)

@mcp.tool()
async def snapshot() -> str:
    """当前页精简可访问性树（每个可交互元素带 [ref]，供 click/type 引用）。"""
    return await _mgr.run(lambda: _snap())
async def _snap(): return await P.snapshot(await _t())

@mcp.tool()
async def click(ref: int) -> dict:
    """点击 snapshot 中编号 ref 的元素。"""
    return await _mgr.run(lambda: _click(ref))
async def _click(ref): return await P.click(await _t(), ref)

@mcp.tool()
async def type_text(ref: int, text: str, submit: bool = False) -> dict:
    """在 ref 元素逐字输入 text；submit=True 回车。"""
    return await _mgr.run(lambda: _type(ref, text, submit))
async def _type(ref, text, submit): return await P.type_text(await _t(), ref, text, submit)

@mcp.tool()
async def fill(ref: int, text: str) -> dict:
    """快速填充 ref 元素（非敏感字段）。"""
    return await _mgr.run(lambda: _fill(ref, text))
async def _fill(ref, text): return await P.fill(await _t(), ref, text)

@mcp.tool()
async def scroll(dy: int = 600) -> dict:
    """滚动。"""
    return await _mgr.run(lambda: _scroll(dy))
async def _scroll(dy): return await P.scroll(await _t(), dy)

@mcp.tool()
async def extract(selector: str) -> dict:
    """抽取匹配 selector 元素的文本（看评论用）。"""
    return await _mgr.run(lambda: _extract(selector))
async def _extract(selector): return await P.extract(await _t(), selector)

@mcp.tool()
async def get_state() -> dict:
    """当前 url/title/被挡标记。"""
    return await _mgr.run(lambda: _state())
async def _state(): return await P.get_state(await _t())

@mcp.tool()
async def screenshot(path: str) -> dict:
    """把当前页截图保存到 path。"""
    return await _mgr.run(lambda: _shot(path))
async def _shot(path):
    tab = await _t(); await tab.save_screenshot(path); return {"ok": True, "path": path}

@mcp.tool()
async def cookies_save(path: str) -> dict:
    """把当前登录态 cookie 存到 path（迁移/备份）。"""
    return await _mgr.run(lambda: _cs(path))
async def _cs(path):
    await _mgr._browser.cookies.save(path); return {"ok": True, "path": path}

@mcp.tool()
async def cookies_load(path: str) -> dict:
    """从 path 载入 cookie。"""
    return await _mgr.run(lambda: _cl(path))
async def _cl(path):
    await _mgr._browser.cookies.load(path); return {"ok": True}

def main() -> None:
    mcp.run()

if __name__ == "__main__":
    main()
```
> 注：`click` 那行的 `if False else` 是笔误风格示例——实现者写成简单的 `return await _mgr.run(lambda: _click(ref))` 即可（与其它工具一致）。`save_screenshot` / `cookies.save|load` 的真实方法名以已装 nodriver 为准（Task 0 探得 cookies 有 save/load；screenshot 方法用 `.venv/bin/python -c "import nodriver;print([m for m in dir(nodriver.Tab) if 'screenshot' in m])"` 核对，常见为 `save_screenshot`）。

- [ ] **Step 4: 跑绿** `.venv/bin/pytest tests/test_server.py -q` → 1 passed（导入即注册；不起浏览器）。
- [ ] **Step 5: 工具名核对** `.venv/bin/python -c "from browser_mcp.server import mcp;import asyncio;print(sorted(t.name for t in asyncio.run(mcp.list_tools())))"` → 含 12 个工具。
- [ ] **Step 6: Commit** `feat(browser-mcp): FastMCP server 注册 12 通用原语 + 串行 + 工具集断言测`

---

## Task 7：README + mcp.json 接入

**Files:** Create `tools/browser-mcp/README.md`

- [ ] **Step 1: 写 README**（含安装、mcp.json `mcpServers.browser` stdio 条目指向 venv python `-m browser_mcp.server`、首次 `use_profile` 弹窗人工登录、**行为安全纪律**：单设备单账号 / 住宅代理 / 人类节奏 / 发布前人工确认 / 反检测≠不封号、headed 默认 `BROWSER_MCP_HEADLESS=1` 切 headless）。
- [ ] **Step 2: 核对 mcp.json schema** `grep -nE "command|args|mcpServers" libs/agent/src/mcp/mcp.schema.ts` 确认字段（顶层 `mcpServers`，stdio `command/args/env`）。
- [ ] **Step 3: Commit** `docs(browser-mcp): README + mcp.json 接入说明`

---

## Task 8：反检测验收（opt-in，headed）

**Files:** Create `tests/test_stealth.py`

- [ ] **Step 1: 写验收测试**
```python
import pytest, tempfile, nodriver as uc
URL = "https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html"

@pytest.mark.online
async def test_stealth_headed():
    b = await uc.start(user_data_dir=tempfile.mkdtemp(), headless=False, sandbox=True)
    try:
        tab = await b.get(URL); await tab.sleep(3)
        wd = await tab.evaluate("navigator.webdriver")
        assert wd in (False, None)
        failed = await tab.evaluate(
            "Array.from(document.querySelectorAll('.failed')).map(e=>e.id||e.innerText).join(' ')",
            return_by_value=True) or ""
        assert "webdriver" not in failed.lower()
    finally:
        b.stop()
```
- [ ] **Step 2: 跑验收** `BROWSER_ONLINE=1 .venv/bin/pytest tests/test_stealth.py -q` → 1 passed（nodriver 实测 webdriver 隐藏 + 无 webdriver 失败项）。
- [ ] **Step 3: Commit** `test(browser-mcp): 反检测验收（intoli, headed, opt-in）`

---

## 首切片验收（手动）
1. 纯单测 `.venv/bin/pytest -q` 全绿（humanize/snapshot/profile/manager/server）。
2. e2e `BROWSER_E2E=1 .venv/bin/pytest -q` 全绿（nodriver 真 Chrome、primitives）。
3. 反检测 `BROWSER_ONLINE=1 .venv/bin/pytest -q` 绿。
4. 接 meshbot：填 mcp.json → 重启 server-agent → agent `use_profile("x")` 弹窗登录 → `navigate`/`snapshot`/`type_text`/`click` 在 X 用通用原语发一条（先 snapshot 预览给用户确认再点发布）+ `extract` 抓一页评论。

## 迁移收尾（验证通过后）
- 删 `tools/browser`（patchright skill）+ `tools/browser-agent`（Camoufox）；旧 spec 标 superseded。

## Self-Review（计划对 spec 覆盖）
- 薄 MCP + tools/browser-mcp 可发布 Python 包 → Task 0/6/7 ✓
- nodriver 真 Chrome + stealth → Task 0/4/8 ✓（API 已实测）
- 通用低层原语 12 工具 → Task 5/6 ✓
- 移植 state.py profile 鲁棒性 → Task 3 ✓
- humanize 行为层 → Task 1（primitives 用之）✓
- cookie 补丁 → Task 4 patches.py ✓
- storage_state 双轨：cookie save/load 已含（Task 6 cookies_save/load）；localStorage 整包导入为后续增量（spec 列为改进项，首切片用 profile 持久化为主，已显式说明）
- 写护栏=流程约定 → README 写明（Task 7）✓
- 反检测验收 → Task 8 ✓
- 测试分层 pytest（纯/browser/online）→ 各任务 ✓
- 注：server.py 里标注的 `save_screenshot`/`cookies.save|load`/`evaluate(return_by_value=)` 等 nodriver 方法名/参数，实现者须按已装 nodriver 0.50.x 实测签名核对（计划已在对应步骤给出核对命令），是唯一需实现期确认的外部 API 细节。
