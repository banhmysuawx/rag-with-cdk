import json
import logging
import os
import boto3
from botocore.exceptions import ClientError
from typing import Dict, Any, List
from datetime import datetime

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)


def get_metadata_for_files(bucket: str, prefix: str) -> List[Dict[str, Any]]:
    """
    Retrieve metadata for all files in a specific S3 prefix/folder.

    Args:
        bucket: S3 bucket name
        prefix: S3 folder prefix (e.g., '20241020/')

    Returns:
        List of metadata dictionaries
    """
    s3_client = boto3.client("s3")
    metadata_list = []

    try:
        # List objects in the specified folder
        paginator = s3_client.get_paginator("list_objects_v2")
        pages = paginator.paginate(Bucket=bucket, Prefix=prefix)

        for page in pages:
            if "Contents" not in page:
                continue

            for obj in page["Contents"]:
                # Skip if it's a folder (ends with '/')
                if obj["Key"].endswith("/"):
                    continue

                try:
                    # Get full metadata for each file
                    response = s3_client.head_object(Bucket=bucket, Key=obj["Key"])

                    metadata = {
                        "bucket": bucket,
                        "key": obj["Key"],
                        "size": response.get("ContentLength", 0),
                        "lastModified": response.get("LastModified", "").isoformat(),
                        "contentType": response.get(
                            "ContentType", "application/octet-stream"
                        ),
                        "path": os.path.dirname(obj["Key"]),
                    }
                    metadata_list.append(metadata)

                except ClientError as head_error:
                    logger.error(
                        f"Error getting metadata for {obj['Key']}: {head_error}"
                    )

    except ClientError as list_error:
        logger.error(f"Error listing objects: {list_error}")

    return metadata_list


def handler(event: Dict[str, Any], context: Any) -> None:
    """
    Lambda handler to process all files in a specific folder and send metadata to SQS.
    """
    # Get configuration from environment variables
    today = datetime.now().strftime("%Y%m%d")
    bucket = os.environ.get("SOURCE_BUCKET", "rag-demo-manual")
    prefix = today + "/"
    queue_url = os.environ.get(
        "QUEUE_URL", "https://sqs.ap-southeast-1.amazonaws.com/905418045741/demo-sqs"
    )

    if not queue_url:
        logger.error("QUEUE_URL environment variable not set")
        return

    # Initialize SQS client
    sqs_client = boto3.client("sqs")

    # Get metadata for all files
    metadata_list = get_metadata_for_files(bucket, prefix)

    # Send each file's metadata to SQS
    for metadata in metadata_list:
        try:
            sqs_client.send_message(
                QueueUrl=queue_url, MessageBody=json.dumps(metadata)
            )
            logger.info(f"Sent metadata for {metadata['key']} to SQS")
        except ClientError as sqs_error:
            logger.error(
                f"Failed to send message to SQS for {metadata['key']}: {sqs_error}"
            )


# For local testing
if __name__ == "__main__":
    handler({}, None)
