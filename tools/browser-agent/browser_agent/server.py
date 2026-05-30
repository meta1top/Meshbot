"""browser-agent MCP server：FastMCP 暴露低层原语，全部经 BrowserManager 串行。"""
from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from . import primitives as P
from .guardrails import WriteGuard
from .manager import BrowserManager

PROFILES_ROOT = Path(__file__).resolve().parent.parent / "profiles"
HEADLESS = os.environ.get("BROWSER_AGENT_HEADLESS", "0") == "1"


@asynccontextmanager
async def _lifespan(_server: "FastMCP") -> AsyncIterator[None]:
    """进程关停时在同一事件循环里关浏览器，避免持久 profile 残留 lock 挡下次启动。"""
    try:
        yield
    finally:
        await _mgr.close()


mcp = FastMCP("browser", lifespan=_lifespan)
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
    st = await _mgr.run(lambda: _nav(url))
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
    """用户确认后，校验 token 并点击 publish_ref 真正发布。

    护栏只保证「确认过才发布」；不校验当前页面 == compose 时的 site，
    调用方（LLM）须确保 confirm 前停留在正确页面，不要中途导航走。
    """
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
