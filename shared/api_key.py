"""Single home for the SSM API-key fetch+cache that the lambdas used to each copy
(WHIT-454). The webhook, sync-trigger, balance-poller and the read API all read an
API key from SSM once per container and reuse it.

The cache is keyed BY PATH on purpose: lambda_api reads two different keys (BankSync
and Anthropic) in the SAME process, so a single un-keyed slot would hand whichever
key was fetched first to the other caller. Each consumer keeps a thin no-argument
wrapper passing its own path.

Flat top-level module (not a package) so the non-recursive `cp shared/*.py`
(terraform/layers.tf) ships it into the layer.
"""

from ssm import get_param

# Process-global (per warm container). Tests that import this module must reset the
# cache between cases — see the `api_key_module` fixture in tests/shared/conftest.py
# and the "api_key" entries in the sibling suites' reimport lists.
_cache: dict[str, str] = {}


def get_api_key(path: str) -> str:
    """Fetch + cache the SSM API key at `path` for the life of the container."""
    if path not in _cache:
        _cache[path] = get_param(path)
    return _cache[path]
