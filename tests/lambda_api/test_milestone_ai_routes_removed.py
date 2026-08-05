"""WHIT-450 — regression guards for the DROPPED milestone-AI endpoints.

The "suggest a plan" (WHIT-370) and "review my plan" (WHIT-371) endpoints were built
server-side but never wired to the API gateway, so they were unreachable in production.
WHIT-450 deleted them (handler block, milestone_ai.py, shared/paydown.py, constants).

These are forward guards at the DISPATCH boundary: they go red if a route or its symbols
are re-introduced, and prove the KEPT GET/PUT /milestones save flow is undisturbed. Reuses
the suite's `handler` fixture (tests/lambda_api/conftest.py).
"""
import json


def _post(path):
    return {"rawPath": path, "requestContext": {"http": {"method": "POST"}}, "body": ""}


def test_suggest_route_now_returns_404(handler):
    resp = handler.lambda_handler(_post("/milestones/suggest"), None)
    assert resp["statusCode"] == 404
    assert json.loads(resp["body"]) == {"error": "Not found"}


def test_review_route_now_returns_404(handler):
    resp = handler.lambda_handler(_post("/milestones/review"), None)
    assert resp["statusCode"] == 404


def test_milestone_ai_symbols_are_gone(handler):
    # Re-adding any of these (even without re-wiring a route) turns this red. The KEPT
    # save flow (get_milestones / set_milestones) is deliberately NOT listed.
    for name in ("suggest_milestones", "review_milestones", "_first_by_index",
                 "suggest_pacing", "review_pacing",
                 "MILESTONES_SUGGEST_PATH", "MILESTONES_REVIEW_PATH"):
        assert not hasattr(handler, name), f"{name} should have been removed from handler"


def test_kept_milestones_route_still_dispatches(handler, monkeypatch):
    # The kept GET /milestones must still route to get_milestones, not fall through to 404.
    sentinel = [{"id": "m1"}]
    monkeypatch.setattr(handler, "get_milestones", lambda *a, **k: sentinel)
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: object())
    resp = handler.lambda_handler(
        {"rawPath": "/milestones", "requestContext": {"http": {"method": "GET"}}, "body": ""}, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == sentinel
