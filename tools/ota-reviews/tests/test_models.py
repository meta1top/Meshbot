from datetime import datetime
from scripts.models import Review


def test_review_minimal_fields_ok():
    r = Review(site="tripadvisor", hotel_key="magellan-sutera", review_id="abc123", text="Great stay")
    assert r.site == "tripadvisor"
    assert r.review_id == "abc123"
    assert r.rating is None
    assert isinstance(r.scraped_at, datetime)


def test_review_dedup_key():
    r = Review(site="agoda", hotel_key="h1", review_id="x9", text="ok")
    assert r.dedup_key() == ("agoda", "x9")


def test_review_rating_coerced_to_float():
    r = Review(site="booking", hotel_key="h1", review_id="r1", text="ok", rating="8.5")
    assert r.rating == 8.5
