from datetime import date
from scripts.models import Review
from scripts.runner import run


def test_run_stores_and_exports_and_returns_summary(tmp_path):
    def fake_scrape(target, max_reviews, fetch):
        return [
            Review(site="tripadvisor", hotel_key=target["hotel_key"], review_id="a", text="x"),
            Review(site="tripadvisor", hotel_key=target["hotel_key"], review_id="b", text="y"),
        ]
    targets = tmp_path / "targets.json"
    targets.write_text('{"h1":{"hotel_name":"H","platforms":{"tripadvisor":"http://x"}}}', encoding="utf-8")
    summary = run(site="tripadvisor", scrape_fn=fake_scrape, hotel_key="h1", max_reviews=100,
                  targets_path=targets, out_root=tmp_path / "out", fetch=None)
    assert summary["new"] == 2
    assert summary["total"] == 2
    assert summary["export"].endswith(f"tripadvisor-h1-{date.today().isoformat()}.json")
    assert (tmp_path / "out" / "reviews.db").exists()
