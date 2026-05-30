import pytest
from browser_agent.guardrails import WriteGuard, GuardError


def test_confirm_requires_prior_compose():
    g = WriteGuard(_token=lambda: "tok-1")
    with pytest.raises(GuardError):
        g.confirm("tok-1")  # 没 compose 过，拒绝


def test_compose_then_confirm_ok():
    g = WriteGuard(_token=lambda: "tok-1")
    tok = g.stage(site="x.com", summary="发推：hello")
    assert tok == "tok-1"
    staged = g.confirm(tok)  # 成功，返回暂存信息
    assert staged.summary == "发推：hello"


def test_token_single_use():
    g = WriteGuard(_token=lambda: "tok-1")
    tok = g.stage(site="x.com", summary="x")
    g.confirm(tok)
    with pytest.raises(GuardError):
        g.confirm(tok)  # 用过即失效


def test_wrong_token_rejected():
    g = WriteGuard(_token=lambda: "tok-1")
    g.stage(site="x.com", summary="x")
    with pytest.raises(GuardError):
        g.confirm("not-the-token")
