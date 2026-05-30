import asyncio
from pathlib import Path
import pytest
from browser_agent.manager import BrowserManager, _host_os, profile_dir


def test_profile_dir_under_base(tmp_path):
    p = profile_dir(tmp_path, "my-x")
    assert p == tmp_path / "my-x"
    assert p.parent == tmp_path


def test_profile_dir_rejects_traversal(tmp_path):
    with pytest.raises(ValueError):
        profile_dir(tmp_path, "../evil")


@pytest.mark.parametrize("bad", ["", ".", "..", "a/b", "a\\b"])
def test_profile_dir_rejects_unsafe_names(tmp_path, bad):
    with pytest.raises(ValueError):
        profile_dir(tmp_path, bad)


@pytest.mark.parametrize(
    "sys_name,expected",
    [("Darwin", "macos"), ("Windows", "windows"), ("Linux", "linux"), ("Other", "linux")],
)
def test_host_os_mapping(monkeypatch, sys_name, expected):
    monkeypatch.setattr("platform.system", lambda: sys_name)
    assert _host_os() == expected


def test_manager_pins_os_to_host(tmp_path):
    # 浏览器的 os 必须钉到宿主（保证 CJK 字体 + 指纹自洽），不能用 Camoufox 随机默认。
    mgr = BrowserManager(profiles_root=tmp_path, headless=True)
    assert mgr._os == _host_os()


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
