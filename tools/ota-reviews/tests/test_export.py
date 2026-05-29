import json
from scripts.models import Review
from scripts.store import ReviewStore


def test_export_json_writes_file(tmp_path):
    store = ReviewStore(tmp_path / "r.db")
    store.upsert([Review(site="trip", hotel_key="h1", review_id="z1", text="hi")])
    out = store.export_json("trip", "h1", tmp_path / "exports", date_str="2026-05-30")
    assert out.exists()
    assert out.name == "trip-h1-2026-05-30.json"
    data = json.loads(out.read_text(encoding="utf-8"))
    assert len(data) == 1
    assert data[0]["review_id"] == "z1"
