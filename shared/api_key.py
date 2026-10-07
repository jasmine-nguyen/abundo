"""Single home for the SSM API-key fetch+cache that the lambdas used to each copy
(WHIT-454). The webhook, sync-trigger, balance-poller and the read API all read an
API key from SSM once per container and reuse it.

The cache is keyed BY PATH on purpose: lambda_api reads two different keys (BankSync
and Anthropic) in the SAME process, so a single un-keyed slot would hand whichever
key was fetched first to the other caller. Each consumer keeps a thin no-argument
wrapper passing its own path.
"""

import boto3
from botocore.exceptions import ClientError

# Process-global (per warm container). Tests that import this module must reset the
# cache between cases — see the `api_key_module` fixture in tests/shared/conftest.py
# and the "api_key" entries in the sibling suites' reimport lists.
_cache: dict[str, str] = {}


def get_param(parameter_name: str) -> str:
    ssm = boto3.client("ssm")
    try:
        response = ssm.get_parameter(Name=parameter_name, WithDecryption=True)
        return response["Parameter"]["Value"]
    except ClientError as e:
        raise ValueError(f"Error fetching parameter {parameter_name}: {e}")


def get_api_key(path: str) -> str:
    """Fetch + cache the SSM API key at `path` for the life of the container."""
    if path not in _cache:
        _cache[path] = get_param(path)
    return _cache[path]


def forget_api_key(path: str) -> None:
    """Drop a key the provider rejected so the next call re-reads SSM."""
    _cache.pop(path, None)
