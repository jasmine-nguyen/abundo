"""ABU-52: the committed .terraform.lock.hcl pins every provider the config needs, for Linux CI and
both Macs, and CI's `terraform init` refuses to re-resolve versions (`-lockfile=readonly`)."""

import re

import pytest

from _terraform import TERRAFORM_DIR

DEPLOY_WORKFLOW = TERRAFORM_DIR.parent / ".github" / "workflows" / "deploy.yml"
PLATFORMS = ("linux_amd64", "darwin_arm64", "darwin_amd64")


def _config(module_dir):
    return "\n".join(path.read_text() for path in sorted(module_dir.glob("*.tf")))


def _declared_constraints(config):
    """provider name -> version constraint from required_providers."""
    block = re.search(r"required_providers\s*\{(.*?)\n  \}", config, re.S).group(1)
    return dict(re.findall(r'(\w+)\s*=\s*\{[^}]*?version\s*=\s*"([^"]+)"', block, re.S))


def _used_providers(config):
    """Every provider a resource or data source belongs to (the type's prefix before `_`)."""
    types = re.findall(r'^(?:resource|data) "([a-z0-9_]+)"', config, re.M)
    return {resource_type.split("_", 1)[0] for resource_type in types}


def _locked(lock_text):
    """provider name -> (constraints or None, number of h1: hashes)."""
    locked = {}
    for name, body in re.findall(r'provider "registry\.terraform\.io/hashicorp/(\w+)" \{(.*?)\n\}', lock_text, re.S):
        constraints = re.search(r'constraints\s*=\s*"([^"]+)"', body)
        locked[name] = (constraints and constraints.group(1), len(re.findall(r'"h1:', body)))
    return locked


@pytest.mark.parametrize("module_dir", [TERRAFORM_DIR, TERRAFORM_DIR / "bootstrap"], ids=["main", "bootstrap"])
def test_lock_file_satisfies_every_provider_on_every_platform(module_dir):
    lock_path = module_dir / ".terraform.lock.hcl"
    assert lock_path.is_file(), f"{lock_path} is missing, so every init picks provider versions fresh"
    config = _config(module_dir)
    declared = _declared_constraints(config)
    locked = _locked(lock_path.read_text())

    assert set(locked) == set(declared) | _used_providers(config)
    for name, (constraints, h1_hashes) in locked.items():
        # -lockfile=readonly fails init when the lock's constraints differ from the config's.
        assert constraints == declared.get(name), f"{name} constraints drifted from providers.tf"
        assert h1_hashes >= len(PLATFORMS), f"{name} lacks hashes for {PLATFORMS}; Linux CI init would fail"


def test_ci_terraform_init_uses_the_lock_file_read_only():
    init_commands = [line for line in DEPLOY_WORKFLOW.read_text().splitlines() if re.search(r"terraform\b.*\binit\b", line)]
    assert len(init_commands) == 2, "expected the plan and apply jobs' init steps"
    for command in init_commands:
        assert "-lockfile=readonly" in command, f"CI init can silently pick new provider versions: {command.strip()}"
