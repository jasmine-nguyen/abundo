#!/usr/bin/env python3
"""One-off, two-way sync of categorisation rules between BankSync and our own store (WHIT-532).

Run on a laptop with the SAME AWS credentials `terraform apply` uses. Preview by default; pass
`--apply` to write. Safe to run twice.

    python scripts/import_banksync_rules.py import                     # preview what import would do
    python scripts/import_banksync_rules.py import --apply             # copy BankSync rules into our store
    python scripts/import_banksync_rules.py delete-from-banksync --apply --app-repointed
                                                                       # AFTER cutover: delete the copies

Two modes:

  import               Copy every BankSync rule into our RuleRepository, keyed by our rule id, and
                       record in a ledger which BankSync id maps to which rule id. Never re-creates
                       a rule the new app deleted or renamed; refuses (does not overwrite) an app
                       edit or a category clash.

  delete-from-banksync Runs import first; stops if anything is refused; then clears the BankSync
                       ids off our rows and DELETEs them from BankSync. Requires --app-repointed
                       (see below) because the app still reads/writes rules in BankSync until a
                       separate WHIT-526 card repoints its Rules screen at our store — deleting
                       before that would empty the screen.

Env (same as the deployed app_api Lambda): TABLE_NAME, AWS_REGION. The BankSync key is read from
SSM at BANKSYNC_API_KEY_PATH via shared/api_key.py — no extra env.

Caveat: preview is not strictly write-free — CategoryRepository.list_categories() seeds the default
taxonomy if the config item is absent. That never happens on the production table (already seeded),
but do not point preview at an empty table expecting zero writes.

Before the first --apply: confirm BankSync's list endpoint does not paginate (no vendored spec
exists in this repo). The script fails closed on any unexpected top-level key or a full page
(>= 100 rules); pass --paging-confirmed to downgrade that to a warning once you have checked.
"""

import argparse
import os
import pathlib
import sys
from dataclasses import dataclass, field as dataclass_field
from datetime import datetime, timezone
from typing import Callable, Optional


def _bootstrap_sys_path() -> None:
    """Put shared/ and lambda_api/ on the path, lambda_api FIRST — the same order prod uses, so
    `banksync_enrichments`'s `from constants import ...` binds lambda_api/constants.py (the shadow
    that shims the shared constants at runtime), not shared/constants.py (AGENTS.md landmine)."""
    root = pathlib.Path(__file__).resolve().parents[1]
    for directory in (str(root / "shared"), str(root / "lambda_api")):
        while directory in sys.path:
            sys.path.remove(directory)
    sys.path.insert(0, str(root / "shared"))
    sys.path.insert(0, str(root / "lambda_api"))


_bootstrap_sys_path()

import rule_engine  # noqa: E402  (after bootstrap)
import banksync_enrichments  # noqa: E402
from banksync_enrichments import BankSyncError  # noqa: E402
# repository_errors imports nothing and reads no env, so it is safe to pull in at load; the
# repositories (which read TABLE_NAME/AWS_REGION at import) are imported lazily in _real_deps().
from repository_errors import (  # noqa: E402
    RuleClashError,
    RuleNotFoundError,
    VersionConflictError,
    DatabaseError,
)

# BankSync caps a rule set at 100 (shared/repository_rule.py docstring). A full page is the
# fail-closed trigger: we cannot tell a truncated first page from a complete one without the spec.
_PAGE_GUARD = 100

# The rule-shape reasons rule_engine._skip_reason returns, mapped to our source-rule kinds.
_REASON_TO_KIND = {
    None: "ok",
    "rule has more than one condition": "multi_condition",
    "unsupported rule type": "unsupported",
    "empty rule value": "empty_value",
    "rule has no category": "no_category",
    "category no longer exists": "unknown_category",
}
# Foreign rules we understand but can't apply, so at cutover we delete their BankSync copies (the
# card: multi-condition / unknown field are "non-importable, deleted at cutover after the list").
_DELETE_AT_CUTOVER = {"multi_condition", "unsupported"}
# Rules we refuse to touch: list them and BLOCK delete mode until a human resolves them in BankSync.
_LIST_ONLY = {"unknown_category", "empty_value", "no_category", "malformed"}


class PagingSuspected(Exception):
    """The BankSync list response might be paginated or otherwise not the whole rule set. We refuse
    both modes rather than import/delete a partial view."""


class BankSyncFailure(Exception):
    """BankSync returned an explicit failure envelope (success=false)."""


@dataclass(frozen=True)
class SourceRule:
    """One BankSync enrichment, normalised. `rule_id` is set only for an importable ('ok') rule."""

    enrichment_id: Optional[str]
    field: Optional[str]
    operator: Optional[str]
    value: Optional[str]
    category_id: Optional[str]
    kind: str          # "ok" | one of _DELETE_AT_CUTOVER | one of _LIST_ONLY | "not_a_rule"
    rule_id: Optional[str]


@dataclass
class Action:
    """One intended write, executed only under --apply. `ledger_bindings` are committed to the
    ledger only if THIS action succeeds (a failed create must not leave its ids 'resolved')."""

    kind: str          # "create" | "stamp" | "delete"
    rule_id: str
    enrichment_ids: tuple = ()
    field: Optional[str] = None
    operator: Optional[str] = None
    value: Optional[str] = None
    category_id: Optional[str] = None
    set_imported_at: bool = True
    expected_updated_at: Optional[str] = None
    ledger_bindings: dict = dataclass_field(default_factory=dict)


@dataclass
class Report:
    imported: list = dataclass_field(default_factory=list)
    present: list = dataclass_field(default_factory=list)
    updated: list = dataclass_field(default_factory=list)
    deleted: list = dataclass_field(default_factory=list)
    resolved: list = dataclass_field(default_factory=list)
    refused: list = dataclass_field(default_factory=list)
    disagreeing: list = dataclass_field(default_factory=list)
    non_importable_deleted: list = dataclass_field(default_factory=list)   # bucket (a)
    non_importable_listed: list = dataclass_field(default_factory=list)     # bucket (b)
    ignored: list = dataclass_field(default_factory=list)                   # not a rule at all
    failed: list = dataclass_field(default_factory=list)                    # execution errors
    warnings: list = dataclass_field(default_factory=list)                  # operator advisories


@dataclass
class ImportPlan:
    actions: list
    report: Report
    passive_bindings: dict            # ledger facts with no pending write (heals / prefer-ours)

    @property
    def blocked(self) -> bool:
        """A refusal or a category disagreement blocks delete mode."""
        return bool(self.report.refused or self.report.disagreeing)

    @property
    def blocked_for_delete(self) -> bool:
        """Anything we refuse to understand — or any write that FAILED during --apply — blocks
        delete mode. A failed category stamp leaves our row stale; deleting its BankSync copy would
        destroy the source of truth for a category we never applied."""
        return self.blocked or bool(self.report.non_importable_listed) or bool(self.report.failed)


@dataclass
class DeletePlan:
    clears: list                      # (rule_id, remaining_ids, set_imported_at, expected)
    enrichment_ids: list              # BankSync ids to DELETE
    refusal: Optional[str] = None     # set -> refuse the whole delete, do nothing


# --- loading + classifying the BankSync response -------------------------------


def load_source_rules(payload: dict, taxonomy_ids: set, *, paging_confirmed: bool = False) -> list:
    """Turn a raw GET /v1/enrichments body into SourceRules, or raise if the response looks
    partial. Uses banksync_enrichments._to_rule + rule_engine._skip_reason so 'importable' and
    'non-importable' mean exactly what the app's own rule engine means."""
    if not isinstance(payload, dict):
        raise PagingSuspected("BankSync response is not an object; refusing to guess its shape")
    # Check the explicit failure envelope BEFORE the data-shape check, so a genuine failure reads as
    # a failure rather than "shape I can't parse" (a failure response often omits `data`).
    if payload.get("success") is False:
        raise BankSyncFailure(f"BankSync returned success=false: {payload.get('error')!r}")
    if not isinstance(payload.get("data"), list):
        raise PagingSuspected("BankSync response has no 'data' list; refusing to guess its shape")

    data = payload["data"]
    suspicions = []
    extra_keys = set(payload) - {"success", "data", "error"}
    if extra_keys:
        suspicions.append(f"unexpected top-level keys {sorted(extra_keys)} (pagination metadata?)")
    if len(data) >= _PAGE_GUARD:
        suspicions.append(f"{len(data)} entries — at or above the {_PAGE_GUARD}-rule page cap")
    if suspicions and not paging_confirmed:
        raise PagingSuspected("; ".join(suspicions))
    if suspicions:
        print("WARNING: paging guard bypassed (--paging-confirmed): " + "; ".join(suspicions))

    def is_unfiled(category):
        return rule_engine.is_unfiled_category(category, taxonomy_ids)

    source = []
    for entry in data:
        entry = entry or {}
        enrichment_id = entry.get("id")
        if entry.get("type") != "rule":
            source.append(SourceRule(enrichment_id, None, None, None, None, "not_a_rule", None))
            continue
        rule = banksync_enrichments._to_rule(entry)
        if rule is None:
            source.append(SourceRule(enrichment_id, None, None, None, None, "malformed", None))
            continue
        kind = _REASON_TO_KIND.get(rule_engine._skip_reason(rule, is_unfiled), "malformed")
        rule_id = (
            rule_engine.rule_id_for(rule["field"], rule["operator"], rule["value"])
            if kind == "ok" else None
        )
        source.append(SourceRule(
            enrichment_id, rule["field"], rule["operator"], rule["value"],
            rule["categoryId"], kind, rule_id,
        ))
    return source


# --- the pure import planner ---------------------------------------------------


def _line(source_rule: SourceRule, **extra) -> dict:
    line = {
        "enrichment_id": source_rule.enrichment_id,
        "value": source_rule.value,
        "category_id": source_rule.category_id,
    }
    line.update(extra)
    return line


def plan_import(source: list, ours: list, ledger: dict, prefer_ours) -> ImportPlan:
    """Decide what import would do. Pure: (BankSync rules, our rows, ledger, prefer-ours ids) ->
    a list of writes + a report. No I/O.

    'untouched' = a script-owned row the app hasn't edited since import (updated_at == imported_at);
    an app-authored row is never untouched. The ledger (BankSync id -> the rule id we bound it to)
    is what tells an in-app text edit (the app moved the id to a new row) apart from a BankSync-side
    text edit (the id is still on the row we put it on) — the two are otherwise identical in the store.
    """
    prefer_ours = set(prefer_ours)
    report = Report()
    mutations: dict = {}          # rule_id -> Action (one write per row, so two edits never collide)
    passive_bindings: dict = {}   # ledger facts with no pending row write

    rows_by_id = {row["id"]: row for row in ours}
    carriers: dict = {}           # enrichment id -> set of rule ids whose row carries it
    for row in ours:
        for enrichment_id in row.get("banksync_enrichment_ids") or []:
            carriers.setdefault(enrichment_id, set()).add(row["id"])

    def touched(row):
        return row.get("updated_at") != row.get("imported_at")

    banksync_ids = {s.enrichment_id for s in source}

    # prefer-ours: the id is cleared off whatever row carries it (recorded per row so it merges
    # into that row's single write below) and ledgered so the next run treats it as resolved.
    cleared: dict = {}
    for enrichment_id in prefer_ours:
        for rule_id in carriers.get(enrichment_id, ()):  # usually 0 or 1
            cleared.setdefault(rule_id, set()).add(enrichment_id)
            passive_bindings[enrichment_id] = rule_id

    # bucket the rules we won't import
    for source_rule in source:
        if source_rule.kind == "ok":
            continue
        if source_rule.kind == "not_a_rule":
            report.ignored.append(_line(source_rule, kind=source_rule.kind))
        elif source_rule.kind in _DELETE_AT_CUTOVER:
            report.non_importable_deleted.append(_line(source_rule, kind=source_rule.kind))
        elif source_rule.kind in _LIST_ONLY:
            report.non_importable_listed.append(_line(source_rule, kind=source_rule.kind))
        else:
            raise AssertionError(f"unclassified source rule kind {source_rule.kind!r}")

    groups: dict = {}
    for source_rule in source:
        if source_rule.kind == "ok":
            groups.setdefault(source_rule.rule_id, []).append(source_rule)

    for rule_id, members in groups.items():
        row = rows_by_id.get(rule_id)
        on_row = set(row.get("banksync_enrichment_ids") or []) if row else set()
        effective_on_row = on_row - cleared.get(rule_id, set())
        group_ids = {m.enrichment_id for m in members}

        resolved = set()
        refused = []
        for enrichment_id in group_ids:
            if enrichment_id in prefer_ours:
                # --prefer-ours means "keep OUR rule, drop this BankSync copy". That only makes
                # sense when there IS an ours to keep: an existing row for this text, or the id
                # sitting on some row of ours. Preferring-ours over a brand-new BankSync rule with
                # no counterpart would drop a rule that exists nowhere else — so ignore the flag
                # there and let the rule import normally, with a warning.
                if row is not None or carriers.get(enrichment_id):
                    resolved.add(enrichment_id)
                    passive_bindings.setdefault(enrichment_id, rule_id)
                    continue
                report.warnings.append(
                    f"--prefer-ours {enrichment_id} ignored: it is a new BankSync rule with no "
                    "rule of ours to keep, so it will be imported instead of dropped")
            elsewhere = carriers.get(enrichment_id, set()) - {rule_id}
            if elsewhere:
                if ledger.get(enrichment_id) == rule_id:
                    # We bound this id to THIS text, but a different row carries it now -> the app
                    # moved it here by a text edit. Don't recreate the old text.
                    resolved.add(enrichment_id)
                else:
                    # The id is still on the row we bound it to, yet BankSync now folds it to a
                    # different rule -> its text was edited on the BankSync side. Refuse.
                    refused.append(enrichment_id)
                continue
            if enrichment_id in ledger and enrichment_id not in effective_on_row:
                # In the ledger but on no relevant row: deleted/renamed in the app, or prefer-ours'd.
                resolved.add(enrichment_id)

        if refused:
            report.refused.append({
                "rule_id": rule_id,
                "enrichment_ids": sorted(refused),
                "reason": "text changed in BankSync since import — resolve it in the app, "
                          "delete it in BankSync, or pass --prefer-ours <id>",
            })
            continue

        for enrichment_id in sorted(resolved):
            report.resolved.append({"rule_id": rule_id, "enrichment_id": enrichment_id})

        live = group_ids - resolved
        if not live:
            # No new id to attach. Still emit the clear if prefer-ours took an id off this row.
            _plan_clear_only(mutations, cleared, rule_id, row, touched)
            continue

        categories = {m.category_id for m in members if m.enrichment_id in live}
        if len(categories) > 1:
            report.disagreeing.append({
                "rule_id": rule_id,
                "categories": {m.enrichment_id: m.category_id for m in members if m.enrichment_id in live},
            })
            continue
        category = categories.pop()
        first = next(m for m in members if m.enrichment_id in live)

        if row is None:
            mutations[rule_id] = Action(
                kind="create", rule_id=rule_id, enrichment_ids=tuple(sorted(live)),
                field=first.field, operator=first.operator, value=first.value,
                category_id=category, ledger_bindings={e: rule_id for e in live},
            )
            report.imported.append({"rule_id": rule_id, "value": first.value,
                                     "category_id": category, "enrichment_ids": sorted(live)})
            continue

        final_ids = tuple(sorted(effective_on_row | live))
        if row.get("category_id") == category:
            missing = live - effective_on_row
            if missing or rule_id in cleared:
                mutations[rule_id] = Action(
                    kind="stamp", rule_id=rule_id, enrichment_ids=final_ids,
                    set_imported_at=not touched(row), expected_updated_at=row.get("updated_at"),
                    ledger_bindings={e: rule_id for e in live},
                )
                report.updated.append({"rule_id": rule_id, "enrichment_ids": list(final_ids)})
            else:
                for enrichment_id in live:
                    if ledger.get(enrichment_id) != rule_id:
                        passive_bindings[enrichment_id] = rule_id
                report.present.append({"rule_id": rule_id, "enrichment_ids": list(final_ids)})
        elif row.get("source") == "app":
            report.refused.append({
                "rule_id": rule_id, "enrichment_ids": sorted(live),
                "reason": f"an app-authored rule files this text to {row.get('category_id')!r}, "
                          f"BankSync files it to {category!r} — the app wins; delete it in BankSync",
            })
        elif not touched(row):
            mutations[rule_id] = Action(
                kind="stamp", rule_id=rule_id, enrichment_ids=final_ids, category_id=category,
                set_imported_at=True, expected_updated_at=row.get("updated_at"),
                ledger_bindings={e: rule_id for e in live},
            )
            report.updated.append({"rule_id": rule_id, "category_id": category,
                                   "enrichment_ids": list(final_ids)})
        else:
            report.refused.append({
                "rule_id": rule_id, "enrichment_ids": sorted(live),
                "reason": f"edited in the app since import (files to {row.get('category_id')!r}, "
                          f"BankSync says {category!r}) — resolve in the app or --prefer-ours <id>",
            })

    # our import rows whose every BankSync copy has vanished -> deleted in the old app (card step 5).
    for row in ours:
        rule_id = row["id"]
        if row.get("source") != "import" or rule_id in mutations or rule_id in cleared:
            continue
        ids = set(row.get("banksync_enrichment_ids") or [])
        if not ids or (ids & banksync_ids):
            continue
        if not touched(row):
            mutations[rule_id] = Action(
                kind="delete", rule_id=rule_id, expected_updated_at=row.get("updated_at"),
            )
            report.deleted.append({"rule_id": rule_id, "enrichment_ids": sorted(ids)})
        else:
            report.refused.append({
                "rule_id": rule_id, "enrichment_ids": sorted(ids),
                "reason": "deleted in BankSync but edited in the app since import — resolve in the app",
            })

    # any prefer-ours clear on a row not otherwise mutated
    for rule_id in cleared:
        if rule_id not in mutations:
            _plan_clear_only(mutations, cleared, rule_id, rows_by_id.get(rule_id), touched)

    return ImportPlan(actions=list(mutations.values()), report=report,
                      passive_bindings=passive_bindings)


def _plan_clear_only(mutations, cleared, rule_id, row, touched) -> None:
    """Emit a stamp that only removes prefer-ours'd ids from a row (no other change)."""
    if row is None or rule_id in mutations or rule_id not in cleared:
        return
    remaining = tuple(sorted(set(row.get("banksync_enrichment_ids") or []) - cleared[rule_id]))
    mutations[rule_id] = Action(
        kind="stamp", rule_id=rule_id, enrichment_ids=remaining,
        set_imported_at=not touched(row), expected_updated_at=row.get("updated_at"),
    )


def execute_import(plan: ImportPlan, repo, *, stamp: str, ledger: dict) -> dict:
    """Apply the plan's writes. `ledger` is the ledger as read BEFORE this run, so only genuinely
    new bindings are written (a rerun with everything already bound writes nothing). Returns the
    bindings that actually landed — a failed write contributes none, so its ids are retried next
    run. Errors are collected into report.failed, not raised; the remaining actions still run."""
    committed = dict(plan.passive_bindings)
    for action in plan.actions:
        try:
            if action.kind == "create":
                repo.create_rule(
                    action.field, action.operator, action.value, action.category_id,
                    source="import", imported_at=stamp,
                    banksync_enrichment_ids=list(action.enrichment_ids), now=stamp,
                )
            elif action.kind == "stamp":
                repo.stamp_import(
                    action.rule_id, stamp=stamp, category_id=action.category_id,
                    banksync_enrichment_ids=list(action.enrichment_ids),
                    set_imported_at=action.set_imported_at,
                    expected_updated_at=action.expected_updated_at,
                )
            elif action.kind == "delete":
                repo.delete_rule(action.rule_id, expected_updated_at=action.expected_updated_at)
            committed.update(action.ledger_bindings)
        except RuleNotFoundError:
            # The row was already gone (a delete/clear the app raced) — treat as done, keep going.
            plan.report.resolved.append({"rule_id": action.rule_id, "enrichment_id": "already gone"})
        except (VersionConflictError, RuleClashError, DatabaseError) as error:
            plan.report.failed.append({"rule_id": action.rule_id, "error": str(error)})

    additions = {e: r for e, r in committed.items() if ledger.get(e) != r}
    repo.add_to_import_ledger(additions, stamp=stamp)
    return committed


# --- delete-from-banksync ------------------------------------------------------


def plan_delete(source: list, ours: list, ledger: dict, import_plan: ImportPlan) -> DeletePlan:
    """After a clean import, decide which BankSync ids to delete and which rows to clear.

    Refuses (does nothing) if import refused/disagreed, if anything is bucket-(b) non-importable,
    or if BankSync holds an importable rule whose id we never bound (import should have created it —
    a surprise means the picture is not what we think)."""
    if import_plan.blocked_for_delete:
        return DeletePlan(clears=[], enrichment_ids=[],
                          refusal="import refused, failed a write, or listed rules that need a "
                                  "human first")

    banksync_ids = {s.enrichment_id for s in source}
    on_row: dict = {}
    for row in ours:
        for enrichment_id in row.get("banksync_enrichment_ids") or []:
            on_row.setdefault(enrichment_id, []).append(row)

    unaccounted = sorted(
        s.enrichment_id for s in source
        if s.kind == "ok" and s.enrichment_id not in on_row and s.enrichment_id not in ledger
    )
    if unaccounted:
        return DeletePlan(clears=[], enrichment_ids=[],
                          refusal=f"BankSync holds rules we never imported: {unaccounted}")

    def touched(row):
        return row.get("updated_at") != row.get("imported_at")

    clears = [
        (row["id"], [], not touched(row), row.get("updated_at"))
        for row in ours if row.get("banksync_enrichment_ids")
    ]
    bucket_a_ids = {s.enrichment_id for s in source if s.kind in _DELETE_AT_CUTOVER}
    ledger_live = {e for e in ledger if e in banksync_ids}
    enrichment_ids = sorted(set(on_row) | bucket_a_ids | ledger_live)
    return DeletePlan(clears=clears, enrichment_ids=enrichment_ids)


def execute_delete(plan: DeletePlan, repo, delete_enrichment: Callable, *, stamp: str) -> list:
    """Clear our rows FIRST, then DELETE from BankSync. Order matters: if the run dies between the
    two, the id still sits in the ledger, so a rerun's import treats it as resolved (no resurrect)
    and delete mode finishes the BankSync delete. The reverse order could delete our own rule.
    Returns a list of failures."""
    failures = []
    held = set()
    for rule_id, remaining, set_imported_at, expected in plan.clears:
        try:
            repo.stamp_import(rule_id, stamp=stamp, banksync_enrichment_ids=remaining,
                              set_imported_at=set_imported_at, expected_updated_at=expected)
        except RuleNotFoundError:
            pass  # row already gone; its ids still get deleted from BankSync below
        except (VersionConflictError, DatabaseError) as error:
            failures.append({"rule_id": rule_id, "error": str(error)})
            held.add(rule_id)

    if held:
        # A row we couldn't clear may still legitimately name ids; don't delete those from BankSync
        # while our store still points at them. Everything else is safe to delete.
        held_ids = set()
        for row in repo.list_rules():
            if row["id"] in held:
                held_ids.update(row.get("banksync_enrichment_ids") or [])
        deletable = [e for e in plan.enrichment_ids if e not in held_ids]
    else:
        deletable = list(plan.enrichment_ids)

    for enrichment_id in deletable:
        try:
            delete_enrichment(enrichment_id)   # 404 is swallowed by banksync_enrichments.delete_rule
        except BankSyncError as error:
            failures.append({"enrichment_id": enrichment_id, "error": str(error)})
    return failures


# --- CLI + reporting -----------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_env() -> Optional[int]:
    missing = [name for name in ("TABLE_NAME", "AWS_REGION") if not os.environ.get(name)]
    if missing:
        print(f"ERROR: set {' and '.join(missing)} (the same values the deployed app_api uses) "
              "before running this script.")
        return 2
    return None


def _real_deps():
    """Build the production dependencies. Imported lazily so `import`-ing this module (and the
    tests that inject fakes) never touches AWS or reads env at load."""
    from repository_rule import RuleRepository
    from repository_category import CategoryRepository
    return (
        RuleRepository(),
        CategoryRepository(),
        lambda: banksync_enrichments._request("GET", banksync_enrichments._ENRICHMENTS),
        banksync_enrichments.delete_rule,
    )


def _print_report(report: Report, *, applied: bool) -> None:
    banner = "APPLIED" if applied else "PREVIEW — nothing written"
    print(f"\n=== {banner} ===")
    sections = [
        ("imported", "Imported (new rules created)"),
        ("updated", "Updated (ids merged / category applied)"),
        ("present", "Already present (no change)"),
        ("resolved", "Resolved (deleted/renamed in the app — not re-created)"),
        ("deleted", "Deleted from our store (gone from BankSync)"),
        ("disagreeing", "Skipped — BankSync copies disagree on category"),
        ("non_importable_deleted", "Non-importable — will be deleted from BankSync at cutover"),
        ("non_importable_listed", "Non-importable — needs a human (blocks delete mode)"),
        ("ignored", "Ignored (not a categorisation rule)"),
        ("refused", "REFUSED (blocks delete mode)"),
        ("failed", "FAILED to write"),
        ("warnings", "Warnings"),
    ]
    for attribute, title in sections:
        lines = getattr(report, attribute)
        if lines:
            print(f"\n{title}: {len(lines)}")
            for line in lines:
                print(f"  - {line}")


def main(argv=None, *, repo=None, category_repo=None, fetch=None,
         delete_enrichment=None, now=None) -> int:
    parser = argparse.ArgumentParser(prog="import_banksync_rules")
    subparsers = parser.add_subparsers(dest="mode", required=True)
    for name in ("import", "delete-from-banksync"):
        sub = subparsers.add_parser(name)
        sub.add_argument("--apply", action="store_true", help="write changes (default: preview)")
        sub.add_argument("--prefer-ours", action="append", default=[], metavar="ENRICHMENT_ID",
                         help="resolve a refused rule by keeping ours and dropping this BankSync id")
        sub.add_argument("--paging-confirmed", action="store_true",
                         help="you have checked BankSync does not paginate; downgrade the guard")
    subparsers.choices["delete-from-banksync"].add_argument(
        "--app-repointed", action="store_true",
        help="confirm the app no longer reads/writes rules in BankSync (a separate WHIT-526 card)")

    args = parser.parse_args(argv)

    injected = repo is not None
    if not injected:
        env_error = _require_env()
        if env_error is not None:
            return env_error
        repo, category_repo, fetch, delete_enrichment = _real_deps()
    now = now or _now
    stamp = now()

    if args.mode == "delete-from-banksync" and not args.app_repointed and args.apply:
        print("ERROR: refusing to delete from BankSync — pass --app-repointed to confirm the app's "
              "Rules screen now reads/writes our store, not BankSync (a separate WHIT-526 card).")
        return 2

    taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
    ledger = repo.get_import_ledger()

    try:
        payload = fetch()
        source = load_source_rules(payload, taxonomy_ids, paging_confirmed=args.paging_confirmed)
    except (PagingSuspected, BankSyncFailure, BankSyncError) as error:
        print(f"ERROR: {error}")
        return 1

    ours = repo.list_rules()
    import_plan = plan_import(source, ours, ledger, args.prefer_ours)

    if args.mode == "import":
        if args.apply:
            execute_import(import_plan, repo, stamp=stamp, ledger=ledger)
        _print_report(import_plan.report, applied=args.apply)
        return _exit_code(import_plan.report)

    # delete-from-banksync: run import first, then delete.
    if args.apply:
        execute_import(import_plan, repo, stamp=stamp, ledger=ledger)
        ours = repo.list_rules()
        ledger = repo.get_import_ledger()
    _print_report(import_plan.report, applied=args.apply)

    delete_plan = plan_delete(source, ours, ledger, import_plan)
    if delete_plan.refusal:
        print(f"\nERROR: not deleting from BankSync — {delete_plan.refusal}")
        return 1

    print(f"\nWould delete {len(delete_plan.enrichment_ids)} BankSync enrichment(s) and clear "
          f"{len(delete_plan.clears)} row(s).")
    if not args.apply:
        print("PREVIEW — nothing written.")
        return 0

    failures = execute_delete(delete_plan, repo, delete_enrichment, stamp=stamp)
    for failure in failures:
        print(f"  FAILED: {failure}")
    return 1 if failures else 0


def _exit_code(report: Report) -> int:
    return 1 if (report.refused or report.disagreeing or report.failed) else 0


if __name__ == "__main__":
    sys.exit(main())
