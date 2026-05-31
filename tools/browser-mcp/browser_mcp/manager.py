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
