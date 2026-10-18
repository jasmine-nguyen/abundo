"""WHIT-655: CloudWatch alarms stay inside the 10-alarm free tier without losing coverage.

Every custom alarm watches a metric some log filter publishes (else it can never fire), and every
filter's metric is watched by an alarm (else a failure is logged and nobody hears about it).
Metric math is billed per metric it reads, so merging with a formula would save nothing.
"""

from _terraform import MONITORING_TF, TERRAFORM_DIR, alarm_metrics, alarm_names, filter_metrics, tf_attr, tf_block

FREE_TIER_ALARMS = 10


def test_alarms_fit_the_free_tier():
    names = alarm_names(MONITORING_TF.read_text())
    assert names, "read no alarms from monitoring.tf: the reader broke, so every check below passes empty"
    assert len(names) <= FREE_TIER_ALARMS, f"{len(names)} alarms, free tier is {FREE_TIER_ALARMS}: {names}"

    for tf_file in TERRAFORM_DIR.glob("*.tf"):
        assert "metric_query" not in tf_file.read_text(), f"{tf_file.name}: metric math is billed per metric read"
        if tf_file != MONITORING_TF:
            assert alarm_names(tf_file.read_text()) == [], f"{tf_file.name} declares an alarm outside monitoring.tf"


def test_every_custom_alarm_watches_a_metric_some_filter_publishes():
    text = MONITORING_TF.read_text()
    published = set(filter_metrics(text).values())
    dead = {
        name: metric for name, metric in alarm_metrics(text).items()
        if not metric[0].startswith('"AWS/') and metric not in published
    }
    assert dead == {}, f"alarms watching a metric no filter publishes: {dead}"


def test_every_filter_metric_is_watched_by_an_alarm():
    text = MONITORING_TF.read_text()
    watched = set(alarm_metrics(text).values())
    orphaned = {name: metric for name, metric in filter_metrics(text).items() if metric not in watched}
    assert orphaned == {}, f"filters nobody alarms on: {orphaned}"


def test_alarm_descriptions_name_lambdas_by_project_name():
    # A renamed project deploys "<project_name>-<lambda>"; a hard-coded name sends on-call to the wrong logs.
    text = MONITORING_TF.read_text()
    hard_coded = [
        name for name in alarm_names(text)
        if "abundo-" in tf_attr(tf_block(text, "aws_cloudwatch_metric_alarm", name), "alarm_description")
    ]
    assert hard_coded == [], f"alarm descriptions hard-coding a lambda name instead of ${{var.project_name}}: {hard_coded}"
