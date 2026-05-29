from scripts import capture as cap


class _FakePage:
    html_content = (
        "<html><head><title>Hotel X Reviews</title></head>"
        "<body><div data-reviewid='1'>good stay</div></body></html>"
    )


def test_capture_writes_fixture_and_returns_path(tmp_path, monkeypatch):
    captured = {}

    class FakeFetcher:
        @staticmethod
        def fetch(url, **kw):
            captured["url"] = url
            captured["kw"] = kw
            return _FakePage()

    monkeypatch.setattr(cap, "StealthyFetcher", FakeFetcher)
    out = cap.capture("tripadvisor", "http://x", wait_selector="div[data-reviewid]", out_dir=tmp_path)
    assert out.exists()
    assert out.name == "tripadvisor_sample.html"
    assert "data-reviewid" in out.read_text(encoding="utf-8")
    assert captured["url"] == "http://x"
    assert captured["kw"]["wait_selector"] == "div[data-reviewid]"
    assert captured["kw"]["headless"] is True
