locals {
  # Single-sourced so the exact build command is also hashed into the trigger
  # below — editing the command (e.g. the tzdata pip step) re-runs the provisioner,
  # which the old static `tzdata = "tzdata"` trigger did NOT catch.
  #
  # Rebuild the staging dir from scratch (a deleted shared file must not linger in
  # the layer) and copy only .py files. The old `cp ../shared/*` was non-recursive
  # and errored on any directory in shared/ (e.g. a __pycache__/ left by running
  # Python there) — and it failed *between* destroying the old layer version and
  # creating the new one, orphaning both lambdas onto a deleted layer. Globbing
  # *.py sidesteps that entirely.
  #
  # tzdata: handler.py uses ZoneInfo("Australia/Sydney") for the payday-aligned
  # budget window, which needs the IANA tz database. Lambda's base image doesn't
  # reliably ship it, so bundle the pure-Python `tzdata` package into the layer
  # (--no-deps: it has none; pure data, no compiled .so, so architecture-safe).
  # Folded into THIS command (not a separate null_resource) so it can't run — or
  # fail — between destroying and recreating the layer version.
  shared_layer_build_command = "rm -rf ${path.module}/layer/python && mkdir -p ${path.module}/layer/python && cp ${path.module}/../shared/*.py ${path.module}/layer/python/ && python3 -m pip install --no-deps --quiet --target ${path.module}/layer/python tzdata"
}

resource "null_resource" "prepare_shared_layer" {
  triggers = {
    # Hash only the .py sources, so a stray __pycache__ can't spuriously churn the
    # layer while any real source change still triggers a rebuild.
    shared_hash = sha256(join("", [for f in fileset("${path.module}/../shared", "*.py") : filesha256("${path.module}/../shared/${f}")]))
    # Re-run if the build command itself changes (adds/edits the tzdata pip step).
    build_command = local.shared_layer_build_command
  }

  provisioner "local-exec" {
    command = local.shared_layer_build_command
  }
}

data "archive_file" "shared_layer_zip" {
  depends_on  = [null_resource.prepare_shared_layer]
  type        = "zip"
  source_dir  = "${path.module}/layer"
  output_path = "${path.module}/artifacts/shared_layer.zip"
}

resource "aws_lambda_layer_version" "shared" {
  layer_name          = "${var.project_name}-shared"
  filename            = data.archive_file.shared_layer_zip.output_path
  source_code_hash    = data.archive_file.shared_layer_zip.output_base64sha256
  compatible_runtimes = ["python3.12"]
}
