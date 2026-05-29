from scripts import fetcher


def test_fetch_passes_url_and_stealth_opts(monkeypatch):
    calls = {}

    class FakeFetcher:
        @staticmethod
        def fetch(url, **kw):
            calls["url"] = url
            calls["kw"] = kw
            return "PAGE"

    monkeypatch.setattr(fetcher, "StealthyFetcher", FakeFetcher)
    f = fetcher.make_fetch(delay_range=(0, 0))
    assert f("http://example.com") == "PAGE"
    assert calls["url"] == "http://example.com"
    assert calls["kw"].get("headless") is True


def test_fetch_forwards_proxy(monkeypatch):
    calls = {}

    class FakeFetcher:
        @staticmethod
        def fetch(url, **kw):
            calls["kw"] = kw
            return "PAGE"

    monkeypatch.setattr(fetcher, "StealthyFetcher", FakeFetcher)
    f = fetcher.make_fetch(delay_range=(0, 0), proxy="http://user:pass@host:8080")
    f("http://example.com")
    assert calls["kw"].get("proxy") == "http://user:pass@host:8080"
