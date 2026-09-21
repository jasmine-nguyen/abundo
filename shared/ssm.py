import boto3
from botocore.exceptions import ClientError


def get_param(parameter_name: str) -> str:
    ssm = boto3.client("ssm")
    try:
        response = ssm.get_parameter(Name=parameter_name, WithDecryption=True)
        return response["Parameter"]["Value"]
    except ClientError as e:
        raise ValueError(f"Error fetching parameter {parameter_name}: {e}")
