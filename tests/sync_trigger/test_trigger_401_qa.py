"""WHIT-644 QA: adversarial checks for the rejected-key path and the trigger alarm wiring.

Handler side: only a 401 drops the cached BankSync key; every other failure keeps it,
and every failure still fails the run (that is what the Errors alarm counts).
Terraform side: the alarm watches the same function the hourly schedule invokes,
and pages the real alerts topic with a runbook that names both known causes.
"""

import io
import pathlib
import re
import urllib.error

import handler
import pytest

_TERRAFORM = pathlib.Path(__file__).resolve().parents[2] / "terraform"


class _FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return b'{"data": {"id": "job-1"}}'


def _http_error(code):
    return urllib.error.HTTPError(
        url="https://api.banksync.io/v1/feeds/x/sync",
        code=code,
        msg="boom",
        hdrs=None,
        fp=io.BytesIO(b""),
    )


@pytest.fixture(autouse=True)
def _reset_api_key_cache():
    import api_key
    api_key._cache.clear()
    yield
    api_key._cache.clear()


@pytest.fixture
def ssm_reads(monkeypatch):
    import api_key
    reads = []

    def fake_get_param(path):
        reads.append(path)
        return f"key-{len(reads)}"

    monkeypatch.setattr(api_key, "get_param", fake_get_param)
    return reads


def _urlopen_raising(error):
    def fake_urlopen(req, timeout=None):
        raise error
    return fake_urlopen


# --- handler: which failures drop the key -----------------------------------


# [A1]
def test_401_on_every_feed_fails_the_run_and_drops_the_cached_key(monkeypatch, ssm_reads):
    import api_key
    monkeypatch.setattr(handler.urllib.request, "urlopen", _urlopen_raising(_http_error(401)))

    with pytest.raises(RuntimeError) as raised:
        handler.lambda_handler({}, None)

    for feed_id in handler.SYNC_FEED_IDS:
        assert feed_id in str(raised.value)
    assert handler.BANKSYNC_API_KEY_PATH not in api_key._cache


# [A2]
@pytest.mark.parametrize("code", [403, 404, 500, 503])
def test_non_401_http_failure_fails_the_run_but_keeps_the_key(monkeypatch, ssm_reads, code):
    monkeypatch.setattr(handler.urllib.request, "urlopen", _urlopen_raising(_http_error(code)))

    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)
    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)

    assert ssm_reads == [handler.BANKSYNC_API_KEY_PATH]


# [A3]
def test_network_failure_fails_the_run_but_keeps_the_key(monkeypatch, ssm_reads):
    monkeypatch.setattr(handler.urllib.request, "urlopen",
                        _urlopen_raising(urllib.error.URLError("timed out")))

    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)
    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)

    assert ssm_reads == [handler.BANKSYNC_API_KEY_PATH]


# [A4]
def test_409_already_running_is_not_a_failure_and_keeps_the_key(monkeypatch, ssm_reads):
    monkeypatch.setattr(handler.urllib.request, "urlopen", _urlopen_raising(_http_error(409)))

    handler.lambda_handler({}, None)
    handler.lambda_handler({}, None)

    assert ssm_reads == [handler.BANKSYNC_API_KEY_PATH]


# [A5]
def test_401_on_one_feed_still_triggers_the_others_and_drops_the_key(monkeypatch, ssm_reads):
    import api_key
    rejected_feed = next(iter(handler.SYNC_FEED_IDS))
    attempted = []

    def fake_urlopen(req, timeout=None):
        feed_id = req.full_url.split("/feeds/")[1].split("/")[0]
        attempted.append(feed_id)
        if feed_id == rejected_feed:
            raise _http_error(401)
        return _FakeResponse()

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(RuntimeError) as raised:
        handler.lambda_handler({}, None)

    assert attempted == list(handler.SYNC_FEED_IDS)
    assert str(raised.value) == f"sync trigger failed for feeds: {[rejected_feed]}"
    assert handler.BANKSYNC_API_KEY_PATH not in api_key._cache


# [A6]
def test_401_only_drops_the_banksync_key_not_other_cached_keys(monkeypatch, ssm_reads):
    import api_key
    api_key.get_api_key("/abundo/anthropic-api-key")
    monkeypatch.setattr(handler.urllib.request, "urlopen", _urlopen_raising(_http_error(401)))

    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)

    assert "/abundo/anthropic-api-key" in api_key._cache


# [A7]
def test_after_a_401_run_the_next_run_reads_ssm_again(monkeypatch, ssm_reads):
    monkeypatch.setattr(handler.urllib.request, "urlopen", _urlopen_raising(_http_error(401)))
    with pytest.raises(RuntimeError):
        handler.lambda_handler({}, None)

    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse())
    handler.lambda_handler({}, None)

    assert ssm_reads == [handler.BANKSYNC_API_KEY_PATH, handler.BANKSYNC_API_KEY_PATH]


# --- terraform: the alarm watches what the schedule runs ----------------------


def _tf_block(text, kind, name):
    match = re.search(rf'resource "{kind}" "{name}" \{{(.*?)\n\}}', text, re.S)
    assert match, f'resource "{kind}" "{name}" not found'
    return match.group(1)


def _tf_attr(block, key):
    match = re.search(rf'^\s*{key}\s*=\s*(.+?)\s*$', block, re.M)
    assert match, f"attribute {key} not found"
    return match.group(1)


def _alarm():
    return _tf_block((_TERRAFORM / "monitoring.tf").read_text(),
                     "aws_cloudwatch_metric_alarm", "transaction_trigger_errors")


# [A8]
def test_alarm_watches_the_function_the_hourly_schedule_invokes():
    schedule = _tf_block((_TERRAFORM / "scheduler.tf").read_text(),
                         "aws_scheduler_schedule", "transaction_sync")
    assert re.search(r"^\s*arn\s*=\s*aws_lambda_function\.transaction_trigger\.arn\s*$", schedule, re.M)
    assert _tf_attr(schedule, "schedule_expression") == "var.sync_schedule_expression"

    function = _tf_block((_TERRAFORM / "lambda.tf").read_text(),
                         "aws_lambda_function", "transaction_trigger")
    assert _tf_attr(function, "function_name") == '"${var.project_name}-transaction-trigger"'
    assert "aws_lambda_function.transaction_trigger.function_name" in _tf_attr(_alarm(), "dimensions")


# [A9]
def test_alarm_pages_the_existing_alerts_topic():
    monitoring = (_TERRAFORM / "monitoring.tf").read_text()
    _tf_block(monitoring, "aws_sns_topic", "alerts")
    assert _tf_attr(_alarm(), "alarm_actions") == "[aws_sns_topic.alerts.arn]"


# [A10]
def test_hours_without_a_run_do_not_count_as_failed_hours():
    assert _tf_attr(_alarm(), "treat_missing_data") == '"notBreaching"'


# [A11]
def test_alarm_name_is_unique_across_monitoring():
    monitoring = (_TERRAFORM / "monitoring.tf").read_text()
    name = _tf_attr(_alarm(), "alarm_name")
    assert name == '"${var.project_name}-transaction-trigger-errors"'
    assert len(re.findall(rf"^\s*alarm_name\s*=\s*{re.escape(name)}\s*$", monitoring, re.M)) == 1


# [A12]
def test_alarm_description_is_a_runbook_for_both_known_causes():
    description = _tf_attr(_alarm(), "alarm_description")

    assert description.startswith('"') and description.endswith('"')
    assert "/aws/lambda/abundo-transaction-trigger" in description
    assert "401" in description
    assert "/abundo/banksync-api-key" in description
    assert "abundo-balance-poller" in description
    assert "404" in description
    assert "SYNC_FEED_IDS" in description


# [A13]
def test_runbook_paths_match_the_real_log_group_and_ssm_path():
    log_group = _tf_block((_TERRAFORM / "lambda.tf").read_text(),
                          "aws_cloudwatch_log_group", "transaction_trigger")
    assert _tf_attr(log_group, "name") == '"/aws/lambda/${var.project_name}-transaction-trigger"'
    assert handler.BANKSYNC_API_KEY_PATH in _tf_attr(_alarm(), "alarm_description")
