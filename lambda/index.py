import os
import json
import logging
import sys
from pip._internal import main

main(
    [
        "install",
        "-I",
        "-q",
        "boto3",
        "requests",
        "opensearch-py==2.4.2",
        "urllib3",
        "--target",
        "/tmp/",
        "--no-cache-dir",
        "--disable-pip-version-check",
    ]
)
sys.path.insert(0, "/tmp/")

import boto3
import requests
from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth
from botocore.exceptions import NoCredentialsError

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def get_opensearch_client(endpoint):
    service = "aoss" if "aoss" in endpoint else "es"
    logger.debug(f"Connecting to OpenSearch service: {service} at {endpoint}")
    return OpenSearch(
        hosts=[
            {
                "host": endpoint,
                "port": 443,
            }
        ],
        http_auth=AWSV4SignerAuth(
            boto3.Session().get_credentials(), os.getenv("AWS_REGION"), service
        ),
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
        pool_maxsize=10,
    )


def handler(event, context):
    logger.info("Received event: %s", json.dumps(event, indent=2))

    # Lấy các tham số từ event với giá trị mặc định
    opensearch_endpoint = event.get("Endpoint")
    index_name = event.get("IndexName")
    vector_dimension = event.get("VectorDimension", 1024)

    if not opensearch_endpoint or not index_name:
        logger.error("Missing required parameters: Endpoint or IndexName")
        return {"statusCode": 400, "body": json.dumps("Missing required parameters")}

    try:
        opensearch_client = get_opensearch_client(opensearch_endpoint)

        # Cấu hình index với dimension động
        params = {
            "index": index_name,
            "body": {
                "settings": {
                    "index": {
                        "knn": True,
                    }
                },
                "mappings": {
                    "properties": {
                        "text": {"type": "text"},
                        "vector_field": {
                            "type": "knn_vector",
                            "dimension": vector_dimension,
                            "method": {
                                "engine": "nmslib",
                                "name": "hnsw",
                                "space_type": "l2",
                            },
                        },
                        "metadata": {
                            "type": "object"
                        },  # Thêm trường metadata từ config gốc
                    }
                },
            },
        }

        # Xử lý các loại request
        if event.get("RequestType") == "Create":
            try:
                opensearch_client.indices.create(
                    index=params["index"], body=params["body"]
                )
                logger.info(f"Index {index_name} created successfully")
                return {
                    "statusCode": 200,
                    "body": json.dumps(f"Index {index_name} created"),
                }
            except Exception as e:
                logger.error(f"Error creating index: {e}")
                return {
                    "statusCode": 500,
                    "body": json.dumps(f"Error creating index: {str(e)}"),
                }

        elif event.get("RequestType") == "Delete":
            try:
                opensearch_client.indices.delete(index=index_name)
                logger.info(f"Index {index_name} deleted successfully")
                return {
                    "statusCode": 200,
                    "body": json.dumps(f"Index {index_name} deleted"),
                }
            except Exception as e:
                logger.error(f"Error deleting index: {e}")
                return {
                    "statusCode": 500,
                    "body": json.dumps(f"Error deleting index: {str(e)}"),
                }

        else:
            logger.error("Invalid RequestType")
            return {"statusCode": 400, "body": json.dumps("Invalid RequestType")}

    except NoCredentialsError:
        logger.error("Credentials not available.")
        return {"statusCode": 403, "body": json.dumps("Credentials not available")}
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        return {"statusCode": 500, "body": json.dumps(f"Unexpected error: {str(e)}")}
