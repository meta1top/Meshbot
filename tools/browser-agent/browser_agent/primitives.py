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
