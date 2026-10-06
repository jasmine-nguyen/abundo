"""AI-insight cache storage (WHIT-104).

The generated suggestions are cached per pay cycle so the paid Anthropic call
isn't repeated on every view. Keyed by the cycle's start date (pk="INSIGHT",
sk=<cycle_start ISO>): the key rolls over automatically on payday, so a new cycle
gets a fresh insight. A single row per cycle, overwritten on regenerate (single
writer), so a plain put_item is enough — no version guard.

`input_hash` (a hash of the numeric input the suggestion was generated from) lets
a regenerate skip the paid call when nothing has changed since the cached run.
"""

from typing import Optional

from repository_base import RepositoryBase, db_errors


class InsightRepository(RepositoryBase):
    """Caches one AI-insight payload per pay cycle at pk="INSIGHT",
    sk=<cycle_start>. `get_insight` returns the stored payload (or None);
    `put_insight` overwrites the cycle's row."""

    def get_insight(self, cycle_start: str) -> Optional[dict]:
        """Return the cached insight for the cycle, or None if not generated yet.

        Surfaces only the payload fields (pk/sk stay internal): summary,
        suggestions, generated_at, input_hash.
        """
        with db_errors("read insight"):
            item = self._get_table().get_item(
                Key={"pk": "INSIGHT", "sk": cycle_start}
            ).get("Item")
        if item is None:
            return None
        return {
            "summary": item.get("summary"),
            "suggestions": list(item.get("suggestions") or []),
            "generated_at": item.get("generated_at"),
            "input_hash": item.get("input_hash"),
        }

    def put_insight(
        self,
        cycle_start: str,
        summary: Optional[str],
        suggestions: list,
        generated_at: str,
        input_hash: str,
    ) -> None:
        """Overwrite the cached insight for the cycle."""
        with db_errors("write insight"):
            self._get_table().put_item(
                Item={
                    "pk": "INSIGHT",
                    "sk": cycle_start,
                    "summary": summary,
                    "suggestions": suggestions,
                    "generated_at": generated_at,
                    "input_hash": input_hash,
                }
            )
