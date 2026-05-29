from scripts.models import Review
from scripts.store import ReviewStore


def _r(review_id: str, text: str = "ok") -> Review:
    return Review(site="tripadvisor", hotel_key="h1", review_id=review_id, text=text)


def test_upsert_returns_new_count(tmp_path):
    store = ReviewStore(tmp_path / "r.db")
    assert store.upsert([_r("a"), _r("b")]) == 2


def test_upsert_dedups_same_site_review_id(tmp_path):
    store = ReviewStore(tmp_path / "r.db")
    store.upsert([_r("a")])
    assert store.upsert([_r("a"), _r("c")]) == 1
    assert store.count() == 2


def test_upsert_updates_existing_text(tmp_path):
    store = ReviewStore(tmp_path / "r.db")
    store.upsert([_r("a", text="old")])
    store.upsert([_r("a", text="new")])
    rows = store.all()
    assert len(rows) == 1
    assert rows[0]["text"] == "new"
