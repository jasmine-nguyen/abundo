# The shared-layer build (rebuild the staging dir from scratch so a deleted shared
# file can't linger; copy only shared/*.py; bundle tzdata for handler.py's ZoneInfo,
# which Lambda's base image doesn't reliably ship) lives in
# scripts/build_terraform_artifacts.sh — the single recipe CI and the local apply
# share. The rm+cp+pip stay one command there so the layer can't be left destroyed
# but not recreated.
resource "null_resource" "prepare_shared_layer" {
  triggers = {
    # Hash only the .py sources, so a stray __pycache__ can't spuriously churn the
    # layer while any real source change still triggers a rebuild.
    shared_hash = sha256(join("", [for f in fileset("${path.module}/../shared", "*.py") : filesha256("${path.module}/../shared/${f}")]))
    # Re-run if the build script itself changes (e.g. the tzdata pip step).
    build_script = filesha256("${path.module}/../scripts/build_terraform_artifacts.sh")
  }

  provisioner "local-exec" {
    command = "bash ${path.module}/../scripts/build_terraform_artifacts.sh shared_layer"
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
