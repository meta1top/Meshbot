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
    shutil.rmtree(default / "Sessions", ignore_errors=True)  # ignore_errors 已吞异常，无需再包
    prefs = default / "Preferences"
    try:
        data = json.loads(prefs.read_text())
        data.get("browser", {}).pop("window_placement", None)
        prefs.write_text(json.dumps(data))
    except (OSError, ValueError):
        pass
