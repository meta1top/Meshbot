import os, pytest
from browser_mcp.profile import profile_dir, read_singleton_pid, is_profile_locked, clean_stale_lock, wipe_window_state

def test_profile_dir(tmp_path):
    assert profile_dir(tmp_path, "acct") == tmp_path / "acct"

def test_profile_dir_traversal(tmp_path):
    for bad in ["", ".", "..", "a/b", "a\\b"]:
        with pytest.raises(ValueError):
            profile_dir(tmp_path, bad)

def test_singleton_pid_and_lock(tmp_path):
    assert read_singleton_pid(tmp_path) is None and is_profile_locked(tmp_path) is False
    link = tmp_path / "SingletonLock"
    os.symlink("somehost-99999999", link)
    assert read_singleton_pid(tmp_path) == 99999999
    assert is_profile_locked(tmp_path) is False  # 陈旧锁 = 未锁

def test_read_singleton_pid_regular_file(tmp_path):
    # 普通文件（非符号链接）：os.readlink 抛 OSError → None
    (tmp_path / "SingletonLock").write_text("not-a-symlink")
    assert read_singleton_pid(tmp_path) is None

def test_read_singleton_pid_hyphenated_host(tmp_path):
    # 主机名含连字符：rsplit('-',1) 仍正确取末段 PID
    os.symlink("my-host-name-1234", tmp_path / "SingletonLock")
    assert read_singleton_pid(tmp_path) == 1234

def test_clean_stale_lock_removes_dead_keeps_alive(tmp_path):
    # 陈旧锁(死 PID) → 删除
    # 注：Chrome 的 SingletonLock 是指向 h-<pid> 的"悬空"符号链接，目标并非真实文件，
    # 故用 is_symlink() 判链本身是否在，而非 exists()（exists 会追链到不存在的目标 → False）。
    stale = tmp_path / "stale"; stale.mkdir()
    os.symlink("h-99999999", stale / "SingletonLock")
    clean_stale_lock(stale)
    assert not (stale / "SingletonLock").is_symlink()
    # 活锁(本进程 PID 存活) → 保留
    alive = tmp_path / "alive"; alive.mkdir()
    os.symlink(f"h-{os.getpid()}", alive / "SingletonLock")
    clean_stale_lock(alive)
    assert (alive / "SingletonLock").is_symlink()

def test_wipe_window_state_keeps_cookies(tmp_path):
    default = tmp_path / "Default"
    default.mkdir(parents=True)
    (default / "Cookies").write_text("KEEP")
    (default / "Current Session").write_text("X")
    (default / "Preferences").write_text('{"profile":{"x":1},"browser":{"window_placement":{"w":0}}}')
    wipe_window_state(tmp_path)
    assert (default / "Cookies").exists()
    assert not (default / "Current Session").exists()
    import json
    prefs = json.loads((default / "Preferences").read_text())
    assert "window_placement" not in prefs.get("browser", {})
