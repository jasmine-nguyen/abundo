"""WHIT-793 slice 3 — api_key reads the secret setting from SSM itself (shared/ssm.py folded in).

Stubbed at the boto3 ssm client layer, so the test exercises api_key's own fetch:
the decrypted read and a ClientError surfacing as ValueError.
"""

import sys

import pytest


class _FakeSsmClient:
    def __init__(self, values, calls):
        self._values = values
        self._calls = calls

    def get_parameter(self, **kwargs):
        self._calls.append(kwargs)
        name = kwargs["Name"]
        if name not in self._values:
            raise sys.modules["botocore.exceptions"].ClientError("ParameterNotFound")
        return {"Parameter": {"Value": self._values[name]}}


def test_get_api_key_fetches_from_the_ssm_client(api_key_module, monkeypatch):
    calls = []
    services = []
    client = _FakeSsmClient({"/bank/key": "bank-secret"}, calls)

    def fake_client(service, *args, **kwargs):
        services.append(service)
        return client

    monkeypatch.setattr(sys.modules["boto3"], "client", fake_client, raising=False)

    with pytest.raises(ValueError, match="/missing"):
        api_key_module.get_api_key("/missing")

    assert api_key_module.get_api_key("/bank/key") == "bank-secret"

    assert set(services) == {"ssm"}
    assert calls[-1] == {"Name": "/bank/key", "WithDecryption": True}
