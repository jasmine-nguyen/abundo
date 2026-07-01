resource "null_resource" "prepare_shared_layer" {
  triggers = {
    shared_hash = sha256(join("", [for f in fileset("${path.module}/../shared", "**") : filesha256("${path.module}/../shared/${f}")]))
  }

  provisioner "local-exec" {
    command = "mkdir -p ${path.module}/layer/python && cp ${path.module}/../shared/* ${path.module}/layer/python/"
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
