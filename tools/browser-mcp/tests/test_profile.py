import os, pytest
from browser_mcp.profile import profile_dir, read_singleton_pid, is_profile_locked, wipe_window_state

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
