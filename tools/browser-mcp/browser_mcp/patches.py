"""按需为 nodriver 打补丁：某些 nodriver/Chrome 组合下 cdp Cookie.from_json 缺字段会 KeyError。
幂等、防御式：仅当存在该类时包一层 setdefault。"""
from __future__ import annotations

def apply() -> None:
    try:
        from nodriver.cdp import network as _net
    except Exception:
        return
    cookie = getattr(_net, "Cookie", None)
    if cookie is None or getattr(cookie, "_mb_patched", False):
        return
    orig = cookie.from_json
    def from_json(cls, json):
        json = dict(json)
        for k, d in (("size", 0), ("priority", "Medium"), ("session", False),
                     ("sameParty", False), ("sourceScheme", "Unset"), ("sourcePort", 0)):
            json.setdefault(k, d)
        return orig.__func__(cls, json) if hasattr(orig, "__func__") else orig(json)
    try:
        cookie.from_json = classmethod(from_json)
        cookie._mb_patched = True
    except Exception:
        pass
