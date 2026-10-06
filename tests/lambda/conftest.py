"""Test bootstrap for the BankSync webhook lambda suite (``lambda/``).

``lambda/`` owns only the webhook-specific ``handler`` / ``webhook_repository`` /
``banksync`` (and imports ``ssm`` / ``standardwebhooks``); ``constants`` /
``models`` / ``api_key`` come from the shared layer (``shared/``), exactly as the
deployed webhook resolves them (its function code shadows the attached layer). The
``lam`` fixture therefore pins ``lambda/`` in front of ``shared/`` on ``sys.path``
— so ``lambda/``'s own copies win and the folded modules fall through to
``shared/``, mirroring ``/var/task`` before ``/opt/python`` in prod — sheds the
colliding bare names from ``sys.modules`` before importing, and restores
everything afterwards.

Unlike the lambda_api fakes (which set ``Key = Attr = object`` because those tests
never query), this suite exercises ``get_pending_transactions_for_account``, so it
installs condition-recording ``Key``/``Attr`` (``_Field``) that the shared
``_dynamo_fakes.FakeTable`` can actually evaluate against a stored item.
"""

import os
import pathlib
import sys
import types

import pytest

from _boto_stubs import use_condition_fields
from _dynamo_fakes import FakeTable

# The webhook now imports the SHARED repository_transaction / repository_base
# (for the budget-alert windowed read, WHIT-22), which read these at import time.
os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("TABLE_NAME", "test-table")


def _fake_import_satisfiers() -> dict:
    """Fake ``ssm`` + ``standardwebhooks`` so ``handler.py`` imports without AWS."""
    ssm = types.ModuleType("ssm")
    ssm.get_param = lambda *a, **k: "fake-secret"

    standardwebhooks = types.ModuleType("standardwebhooks")
    webhooks = types.ModuleType("standardwebhooks.webhooks")

    class Webhook:
        def __init__(self, *a, **k):
            pass

        def verify(self, *a, **k):
            return {}

    webhooks.Webhook = Webhook
    standardwebhooks.webhooks = webhooks
    return {
        "ssm": ssm,
        "standardwebhooks": standardwebhooks,
        "standardwebhooks.webhooks": webhooks,
    }


_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LAMBDA_DIR = str(_REPO_ROOT / "lambda")
_SHARED_DIR = str(_REPO_ROOT / "shared")
# Bare module names whose imports must resolve fresh per test: lambda/'s own copies
# (handler / webhook_repository / banksync) plus the folded modules now provided by shared/
# (constants / models / api_key). Shed so a sibling suite's cached copy can't win —
# including the shared facade `repository` another suite may have cached.
_REIMPORT = ("handler", "up_webhook", "constants", "models", "repository", "webhook_repository", "reconcile", "banksync", "api_key", "merchant", "reprocess", "age_out",
             "budget_alerts", "repayment_alerts", "spend", "budget_standing", "push", "repository_base", "repository_transaction", "repository_budget",
             "repository_category", "repository_device", "repository_notify", "repository_paycycle", "rule_engine",
             "rule_ingest", "repository_rule", "pending_carry")


@pytest.fixture
def lam():
    """Import the webhook lambda's modules in isolation; yield the ones tests use.

    Unlike the handler suites, this one queries, so ``use_condition_fields`` swaps in
    the condition-recording Key/Attr while the repositories are imported (they bind it
    via ``from boto3.dynamodb.conditions import Key``) and FakeTable can evaluate them."""
    with use_condition_fields():
        saved_fakes = {}
        for name, mod in _fake_import_satisfiers().items():
            saved_fakes[name] = sys.modules.get(name)
            sys.modules[name] = mod

        for d in (_LAMBDA_DIR, _SHARED_DIR):
            while d in sys.path:
                sys.path.remove(d)
        # shared/ first, then lambda/ on top: lambda/ wins for its own modules, and the
        # folded ones (constants / models / api_key) fall through to shared/.
        sys.path.insert(0, _SHARED_DIR)
        sys.path.insert(0, _LAMBDA_DIR)
        saved_real = {name: sys.modules.pop(name, None) for name in _REIMPORT}

        import api_key
        import banksync
        import handler
        import up_webhook
        import merchant
        import models
        import reconcile
        import webhook_repository
        import reprocess
        import age_out
        import budget_alerts
        import repayment_alerts
        import rule_ingest

        ns = types.SimpleNamespace(
            repository=webhook_repository, reconcile=reconcile, banksync=banksync, handler=handler, models=models,
            merchant=merchant, reprocess=reprocess,
            age_out=age_out,
            budget_alerts=budget_alerts, repayment_alerts=repayment_alerts,
            up_webhook=up_webhook, rule_ingest=rule_ingest,
            # Fresh per test, so its SSM cache starts empty: seed `_cache` or stub `get_param` here.
            api_key=api_key,
        )
        try:
            yield ns
        finally:
            for name in _REIMPORT:
                sys.modules.pop(name, None)
                if saved_real[name] is not None:
                    sys.modules[name] = saved_real[name]
            for name, orig in saved_fakes.items():
                if orig is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = orig
            for d in (_LAMBDA_DIR, _SHARED_DIR):
                while d in sys.path:
                    sys.path.remove(d)


@pytest.fixture
def repo(lam):
    """The webhook's own TransactionRepository subclass over the shared FakeTable."""
    r = lam.repository.TransactionRepository()
    r._table = FakeTable()
    return r
