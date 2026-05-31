"""低层原语：对 nodriver tab 的薄封装，交互内置人类节奏。元素用 data-mb-ref 定位。

注意：nodriver 0.50.3 的 `tab.evaluate(..., return_by_value=True)` 对数组/对象返回裸
RemoteObject（value=None），不返回 Python 值。改用 JSON.stringify 在浏览器侧序列化，
Python 侧 json.loads 解析，确保结构化数据正确还原。
"""
from __future__ import annotations
import json
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
    # JSON.stringify in-browser; nodriver 0.50.3 returns array objects as RemoteObject
    # when return_by_value=True (value field is None for arrays), so we stringify instead.
    raw_json = await tab.evaluate(f"JSON.stringify({COLLECT_JS.strip()})")
    raw = json.loads(raw_json) if isinstance(raw_json, str) else []
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
    # Same JSON.stringify workaround: return_by_value=True doesn't resolve for arrays.
    js = ("JSON.stringify(Array.from(document.querySelectorAll(" + repr(selector) +
          ")).map(e=>({text:(e.innerText||'').trim()})))")
    raw = await tab.evaluate(js)
    items = json.loads(raw) if isinstance(raw, str) else []
    return {"ok": True, "count": len(items), "data": items}
