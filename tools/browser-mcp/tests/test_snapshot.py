from browser_mcp.snapshot import COLLECT_JS, format_snapshot


def test_collect_js_const():
    assert isinstance(COLLECT_JS, str) and "data-mb-ref" in COLLECT_JS


def test_format_basic():
    raw = [{"ref": 1, "role": "textbox", "name": "用户名"}, {"ref": 2, "role": "button", "name": "登录"}]
    out = format_snapshot(raw, 32000)
    assert "[1] textbox 用户名" in out and "[2] button 登录" in out


def test_format_truncate():
    raw = [{"ref": i, "role": "button", "name": "x" * 50} for i in range(2000)]
    out = format_snapshot(raw, 4000)
    assert len(out.encode()) <= 4000 and "truncated" in out


def test_format_empty():
    assert format_snapshot([{"ref": 0, "role": "generic", "name": ""}], 32000).strip() == "(no interactive elements)"
