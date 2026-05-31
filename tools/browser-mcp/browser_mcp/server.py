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


async def _t():
    return await _mgr.tab()


@mcp.tool()
async def use_profile(name: str) -> str:
    """启动/切换某账号的持久隐身 profile（首次需在弹出的 Chrome 里人工登录）。"""
    await _mgr.ensure_profile(name)
    return f"profile={name} ready (headless={HEADLESS})"


@mcp.tool()
async def navigate(url: str) -> dict:
    """导航到 url，返回状态（含是否疑似被挡）。"""
    return await _mgr.run(lambda: _nav(url))


async def _nav(url):
    return await P.navigate(await _t(), url)


@mcp.tool()
async def snapshot() -> str:
    """当前页精简可访问性树（每个可交互元素带 [ref]，供 click/type 引用）。"""
    return await _mgr.run(lambda: _snap())


async def _snap():
    return await P.snapshot(await _t())


@mcp.tool()
async def click(ref: int) -> dict:
    """点击 snapshot 中编号 ref 的元素。"""
    return await _mgr.run(lambda: _click(ref))


async def _click(ref):
    return await P.click(await _t(), ref)


@mcp.tool()
async def type_text(ref: int, text: str, submit: bool = False) -> dict:
    """在 ref 元素逐字输入 text；submit=True 回车。"""
    return await _mgr.run(lambda: _type(ref, text, submit))


async def _type(ref, text, submit):
    return await P.type_text(await _t(), ref, text, submit)


@mcp.tool()
async def fill(ref: int, text: str) -> dict:
    """快速填充 ref 元素（非敏感字段）。"""
    return await _mgr.run(lambda: _fill(ref, text))


async def _fill(ref, text):
    return await P.fill(await _t(), ref, text)


@mcp.tool()
async def scroll(dy: int = 600) -> dict:
    """滚动。"""
    return await _mgr.run(lambda: _scroll(dy))


async def _scroll(dy):
    return await P.scroll(await _t(), dy)


@mcp.tool()
async def extract(selector: str) -> dict:
    """抽取匹配 selector 元素的文本（看评论用）。"""
    return await _mgr.run(lambda: _extract(selector))


async def _extract(selector):
    return await P.extract(await _t(), selector)


@mcp.tool()
async def get_state() -> dict:
    """当前 url/title/被挡标记。"""
    return await _mgr.run(lambda: _state())


async def _state():
    return await P.get_state(await _t())


@mcp.tool()
async def screenshot(path: str) -> dict:
    """把当前页截图保存到 path。"""
    return await _mgr.run(lambda: _shot(path))


async def _shot(path):
    tab = await _t()
    await tab.save_screenshot(path)
    return {"ok": True, "path": path}


@mcp.tool()
async def cookies_save(path: str) -> dict:
    """把当前登录态 cookie 存到 path（迁移/备份）。"""
    return await _mgr.run(lambda: _cs(path))


async def _cs(path):
    if _mgr._browser is None:
        raise RuntimeError("尚未 use_profile")
    await _mgr._browser.cookies.save(path)
    return {"ok": True, "path": path}


@mcp.tool()
async def cookies_load(path: str) -> dict:
    """从 path 载入 cookie。"""
    return await _mgr.run(lambda: _cl(path))


async def _cl(path):
    if _mgr._browser is None:
        raise RuntimeError("尚未 use_profile")
    await _mgr._browser.cookies.load(path)
    return {"ok": True}


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
