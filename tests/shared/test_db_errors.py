"""db_errors (shared/repository_base.py, WHIT-790): the one shared wrapper every plain database
read and write reports its failures through."""

import pytest


def test_db_errors_turns_a_client_error_into_a_database_error_and_lets_other_errors_through(
    shared, database_error, client_error
):
    import repository_base

    original = client_error("ProvisionedThroughputExceededException", "throttled")
    with pytest.raises(database_error, match="^Database read failed: throttled$") as excinfo:
        with repository_base.db_errors("read"):
            raise original
    assert excinfo.value.__cause__ is original

    with pytest.raises(ValueError, match="not a database problem"):
        with repository_base.db_errors("write"):
            raise ValueError("not a database problem")

    with repository_base.db_errors("read"):
        result = "kept"
    assert result == "kept"
