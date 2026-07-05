"""Test bootstrap for the Cognito Pre-Sign-Up allowlist lambda (WHIT-162).

`lambda_presignup/handler.py` is dependency-free (no shared layer, no boto3). But
several suites define a top-level ``handler``, so a bare ``import handler`` in one
process could return a sibling's copy. The ``presignup`` fixture sheds that name,
pins this lambda's dir to the front of sys.path, imports, then restores the module
table.
"""

import pathlib
import sys

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_PRESIGNUP_DIR = str(_REPO_ROOT / "lambda_presignup")

# Collides with the sibling lambda_authorizer / lambda_api / sync_trigger suites.
_COLLIDING = ("handler",)


@pytest.fixture
def presignup():
    """Import lambda_presignup/handler.py in isolation and hand it to the test."""
    while _PRESIGNUP_DIR in sys.path:
        sys.path.remove(_PRESIGNUP_DIR)
    sys.path.insert(0, _PRESIGNUP_DIR)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    import handler as h

    try:
        yield h
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod
