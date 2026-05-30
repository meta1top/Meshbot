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
