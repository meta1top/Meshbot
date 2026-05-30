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
