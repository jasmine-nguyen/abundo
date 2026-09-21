"""WHIT-450 — the milestone-AI constant deletion did not clip the KEPT /milestones path.

WHIT-450 removed MILESTONES_SUGGEST_PATH + MILESTONES_REVIEW_PATH from lambda_api/constants.py.
They sat immediately AFTER the kept MILESTONES_PATH (the GET/PUT save route). A boundary slip
that clipped the wrong line would silently break the save route's dispatch. handler-symbol
guards live in test_milestone_ai_routes_removed.py; this guards the CONSTANTS module itself.

Fail-on-revert: change constants.MILESTONES_PATH's value -> the equality reddens; re-add either
deleted path constant -> the `not hasattr` reddens. Reuses the lambda_api `handler` fixture,
which loads the same shadowing constants module the deployed API uses (WHIT-136).
"""


def test_kept_milestones_path_constant_survived(handler):
    # [GAP-C1] The save route's path constant is intact and unchanged.
    import constants
    assert constants.MILESTONES_PATH == "/milestones"
    assert handler.MILESTONES_PATH == "/milestones"


def test_deleted_ai_path_constants_are_gone_from_the_module(handler):
    # [GAP-C2] The two AI-route constants are removed from the module, not just unimported.
    import constants
    for name in ("MILESTONES_SUGGEST_PATH", "MILESTONES_REVIEW_PATH"):
        assert not hasattr(constants, name), f"{name} should be gone from lambda_api/constants.py"
