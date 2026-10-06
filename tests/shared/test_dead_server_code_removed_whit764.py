"""WHIT-764: the dead server code is gone and the milestone inputs are required.

Names are built from pieces so a repo-wide grep for the deleted names never matches this file.
"""

import inspect
import pathlib

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_milestone_crossing_needs_an_explicit_plan_and_milestone_store(shared):
    milestones = shared.milestones

    crossed = milestones.crossed_milestones(430000, 400000, milestones.MILESTONES)
    assert [m.label for m in crossed] == ["Quarter way"]
    with pytest.raises(TypeError):
        milestones.crossed_milestones(430000, 400000)

    notify_params = inspect.signature(milestones.notify_milestone_crossing).parameters
    assert notify_params["milestone_repo"].default is inspect.Parameter.empty
    assert notify_params["milestone_repo"].kind is inspect.Parameter.KEYWORD_ONLY
    assert notify_params["scope"].default is None

    resolve_params = inspect.signature(milestones._resolve_plan).parameters
    assert resolve_params["milestone_repo"].default is inspect.Parameter.empty


def test_server_code_with_no_callers_is_deleted(shared):
    import models

    assert not hasattr(shared.spend, "payback" + "_slice")
    assert not hasattr(shared.spend, "accrue" + "_buffer")
    assert hasattr(shared.spend, "unified_available")
    assert not hasattr(shared.milestones, "resolve" + "_plan")
    assert not hasattr(shared.job.JobRepository, "list" + "_jobs")
    assert not hasattr(models, "Cate" + "gory")
    assert hasattr(models, "Transaction")

    handler_source = (_REPO_ROOT / "lambda_api" / "handler.py").read_text()
    assert ("_is_" + "unmapped_category") not in handler_source
    assert "is_unfiled_category" in handler_source
