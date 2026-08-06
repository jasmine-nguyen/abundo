"""Shared AWS import-satisfiers for the server test suites.

Importing a Lambda's ``handler.py`` (or the shared ``repository_*`` modules) in a
unit test pulls in ``boto3`` / ``botocore`` / ``ssm`` and reads ``AWS_REGION`` /
``TABLE_NAME`` at load — none of which is needed to unit-test the logic. Every
suite used to carry its own byte-identical copy of the fakes that satisfy that
import chain. This module holds the single copy (WHIT-466).

Two entry points, for the two things suites actually need:

- ``install_import_satisfiers(ssm_default=...)`` — the full bundle the handler
  suites use at module load: env vars + fake ``boto3``/``botocore`` + fake ``ssm``.
  Handler tests replace the repository wholesale, so the fakes are import-only.
- ``use_condition_fields()`` — a context manager for the ``shared`` / ``lambda``
  repository suites, which DO query. It swaps ``boto3``'s ``Key``/``Attr`` for the
  condition-recording ``_Field`` while the repositories are imported (they bind it
  via ``from boto3.dynamodb.conditions import Key``), then restores them.

Both share one fake ``boto3``/``botocore`` builder, so every suite sees the same
shape regardless of which one collects first. Each install is idempotent — it
guards on the module already being in ``sys.modules`` — so the first suite to run
wins and the rest no-op, exactly as the per-suite copies did.
"""

import os
import sys
import types
from contextlib import contextmanager


class _Predicate:
    """A boto3 condition stand-in a fake table can evaluate against an item."""

    def __init__(self, fn):
        self._fn = fn

    def evaluate(self, item) -> bool:
        return self._fn(item)

    def __and__(self, other):
        return _Predicate(lambda item: self._fn(item) and other.evaluate(item))


class _Field:
    """Fake boto3 Key/Attr: ``_Field(name).eq(v)`` / ``.between(lo, hi)`` / ``.gte(lo)``
    → _Predicate. ``.gte`` is used only by the shared repository suite; leaving it on
    the field the webhook suite sees is harmless (that suite never queries with it)."""

    def __init__(self, name):
        self._name = name

    def eq(self, value):
        name = self._name
        return _Predicate(lambda item: item.get(name) == value)

    def gte(self, lo):
        name = self._name
        return _Predicate(lambda item: item.get(name, "") >= lo)

    def between(self, lo, hi):
        name = self._name
        return _Predicate(lambda item: lo <= item.get(name, "") <= hi)


def _install_fake_boto3_botocore():
    """Register lightweight fake ``boto3`` / ``botocore`` modules (idempotent).

    The fake is a superset serving every suite: ``resource`` is present (the
    repositories call it lazily in ``_get_table``, but tests inject ``_table`` so
    it is never actually invoked), and ``conditions.Key``/``Attr`` default to
    ``object`` so the handler suites' ``from boto3.dynamodb.conditions import Key``
    resolves. The repository suites overwrite ``Key``/``Attr`` with ``_Field`` for
    the duration of their imports (see ``use_condition_fields``).
    """
    if "boto3" not in sys.modules:
        boto3 = types.ModuleType("boto3")
        boto3.resource = lambda *a, **k: None  # never called: repo._table is injected
        conditions = types.ModuleType("boto3.dynamodb.conditions")
        conditions.Key = object
        conditions.Attr = object
        dynamodb = types.ModuleType("boto3.dynamodb")
        dynamodb.conditions = conditions
        boto3.dynamodb = dynamodb
        sys.modules.update({
            "boto3": boto3,
            "boto3.dynamodb": dynamodb,
            "boto3.dynamodb.conditions": conditions,
        })
    if "botocore" not in sys.modules:
        botocore = types.ModuleType("botocore")
        exceptions = types.ModuleType("botocore.exceptions")

        class ClientError(Exception):
            pass

        exceptions.ClientError = ClientError
        botocore.exceptions = exceptions
        sys.modules.update({"botocore": botocore, "botocore.exceptions": exceptions})


def install_import_satisfiers(ssm_default: str = "test-key"):
    """Set the env vars and register the fake boto3/botocore/ssm a handler suite
    needs before importing its ``handler.py``. ``ssm_default`` is the value the fake
    ``ssm.get_param`` returns; each suite keeps its own so intent stays readable,
    though tests that care about the key monkeypatch it directly."""
    os.environ.setdefault("AWS_REGION", "ap-southeast-2")
    os.environ.setdefault("TABLE_NAME", "test-table")
    _install_fake_boto3_botocore()
    if "ssm" not in sys.modules:
        ssm = types.ModuleType("ssm")
        ssm.get_param = lambda parameter_name: ssm_default
        sys.modules["ssm"] = ssm


@contextmanager
def use_condition_fields():
    """Swap boto3's ``Key``/``Attr`` for the condition-recording ``_Field`` for the
    duration of the block, restoring them on exit. The repository suites wrap their
    fixture body in this: the repositories capture ``_Field`` via
    ``from boto3.dynamodb.conditions import Key`` at import and keep it for the whole
    test, so every ``Key``/``Attr``-binding import must happen inside the block."""
    _install_fake_boto3_botocore()
    conditions = sys.modules["boto3.dynamodb.conditions"]
    saved_key = getattr(conditions, "Key", None)
    saved_attr = getattr(conditions, "Attr", None)
    conditions.Key = _Field
    conditions.Attr = _Field
    try:
        yield
    finally:
        conditions.Key = saved_key
        conditions.Attr = saved_attr
