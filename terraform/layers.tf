resource "null_resource" "prepare_shared_layer" {
  triggers = {
    # Hash only the .py sources, so a stray __pycache__ can't spuriously churn the
    # layer while any real source change still triggers a rebuild.
    shared_hash = sha256(join("", [for f in fileset("${path.module}/../shared", "*.py") : filesha256("${path.module}/../shared/${f}")]))
  }

  provisioner "local-exec" {
    # Rebuild the staging dir from scratch (a deleted shared file must not linger
    # in the layer) and copy only .py files. The old `cp ../shared/*` was
    # non-recursive and errored on any directory in shared/ (e.g. a __pycache__/
    # left by running Python there) — and it failed *between* destroying the old
    # layer version and creating the new one, orphaning both lambdas onto a
    # deleted layer. Globbing *.py sidesteps that entirely.
    command = "rm -rf ${path.module}/layer/python && mkdir -p ${path.module}/layer/python && cp ${path.module}/../shared/*.py ${path.module}/layer/python/"
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
