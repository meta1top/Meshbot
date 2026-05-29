import json
import pytest
from scripts.targets import load_target, TargetNotFound


def _write(tmp_path, data):
    p = tmp_path / "targets.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def test_load_target_returns_url_and_name(tmp_path):
    p = _write(tmp_path, {"h1": {"hotel_name": "Hotel One",
        "platforms": {"tripadvisor": "http://x", "trip": "", "agoda": "", "booking": ""}}})
    t = load_target(p, "tripadvisor", "h1")
    assert t["url"] == "http://x"
    assert t["hotel_name"] == "Hotel One"
    assert t["hotel_key"] == "h1"


def test_load_target_missing_hotel_raises(tmp_path):
    with pytest.raises(TargetNotFound):
        load_target(_write(tmp_path, {}), "tripadvisor", "nope")


def test_load_target_empty_url_raises(tmp_path):
    p = _write(tmp_path, {"h1": {"hotel_name": "H", "platforms": {"agoda": ""}}})
    with pytest.raises(TargetNotFound):
        load_target(p, "agoda", "h1")
