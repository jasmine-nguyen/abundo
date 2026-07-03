"""Test bootstrap for the API Gateway authorizer lambda.

``lambda_authorizer/handler.py`` imports two layer-provided modules:

    from constants import API_AUTH_TOKEN_PATH   # -> shared/constants.py
    from ssm import get_param                   # shared/ssm.py, which needs boto3

Three suites (lambda_api, sync_trigger, this) all define a top-level ``handler``
(and ``constants``), so a bare ``import handler`` in one process could return a
sibling's copy. The ``authorizer`` fixture sheds those names, pins this package's
dirs to the front of sys.path, imports, then restores the module table. A fake
``ssm`` keeps the import off boto3/AWS.
"""

import pathlib
import sys
import types

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_AUTHORIZER_DIR = str(_REPO_ROOT / "lambda_authorizer")
_SHARED_DIR = str(_REPO_ROOT / "shared")

# Fake `ssm` so `from ssm import get_param` needs no boto3. Tests that care about
# the token monkeypatch handler.get_param / handler._token directly.
if "ssm" not in sys.modules:
    _ssm = types.ModuleType("ssm")
    _ssm.get_param = lambda parameter_name: "test-token"
    sys.modules["ssm"] = _ssm

# Names that collide with the sibling lambda_api / sync_trigger suites.
_COLLIDING = ("handler", "constants")


@pytest.fixture
def authorizer():
    """Import lambda_authorizer/handler.py in isolation and hand it to the test."""
    for d in (_SHARED_DIR, _AUTHORIZER_DIR):
        while d in sys.path:
            sys.path.remove(d)
    sys.path.insert(0, _SHARED_DIR)
    sys.path.insert(0, _AUTHORIZER_DIR)

    saved = {name: sys.modules.pop(name, None) for name in _COLLIDING}
    import handler as h

    h._token = None  # never leak a cached token across tests
    try:
        yield h
    finally:
        for name in _COLLIDING:
            sys.modules.pop(name, None)
        for name, mod in saved.items():
            if mod is not None:
                sys.modules[name] = mod
