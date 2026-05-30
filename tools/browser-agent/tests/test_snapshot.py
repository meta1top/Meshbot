from browser_agent.snapshot import format_snapshot, COLLECT_JS


def test_collect_js_is_nonempty_string():
    assert isinstance(COLLECT_JS, str) and "data-mb-ref" in COLLECT_JS


def test_format_basic_tree():
    raw = [
        {"ref": 1, "role": "textbox", "name": "用户名"},
        {"ref": 2, "role": "button", "name": "登录"},
    ]
    out = format_snapshot(raw, max_bytes=32_000)
    assert "[1] textbox 用户名" in out
    assert "[2] button 登录" in out


def test_format_truncates_to_budget():
    raw = [{"ref": i, "role": "button", "name": "x" * 50} for i in range(2000)]
    out = format_snapshot(raw, max_bytes=4_000)
    assert len(out.encode("utf-8")) <= 4_000
    assert "truncated" in out  # 截断有显式标记，不静默


def test_format_skips_nameless_noninteractive():
    raw = [{"ref": 0, "role": "generic", "name": ""}]
    out = format_snapshot(raw, max_bytes=32_000)
    assert out.strip() == "(no interactive elements)"
