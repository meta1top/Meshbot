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
