import os
import json
import logging
import sys

# from pip._internal import main

# # Install required packages at runtime
# main(
#     [
#         "install",
#         "-I",
#         "-q",
#         "boto3",
#         "requests",
#         "opensearch-py==2.4.2",
#         "urllib3",
#         "google-generativeai",
#         "langchain-core",
#         "langchain-core",
#         "langchain_google_genai",
#         "requests-aws4auth",
#         "--target",
#         "/tmp/",
#         "--no-cache-dir",
#         "--disable-pip-version-check",
#     ]
# )
# sys.path.insert(0, "/tmp/")

import os
import json
import logging
import boto3
from typing import Dict, Any, List
from requests_aws4auth import AWS4Auth
from opensearchpy import RequestsHttpConnection
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings
import google.generativeai as genai
from langchain_community.vectorstores import OpenSearchVectorSearch
from langchain_community.document_loaders.s3_file import S3FileLoader

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)


# Function to fetch secrets from AWS Secrets Manager
def get_secret(secret_name: str, region_name: str) -> Dict[str, str]:
    client = boto3.client("secretsmanager", region_name=region_name)
    try:
        get_secret_value_response = client.get_secret_value(SecretId=secret_name)
        secret = get_secret_value_response["SecretString"]
        return json.loads(secret)
    except Exception as e:
        logger.error(f"Error fetching secret {secret_name}: {str(e)}")
        raise e


# Fetch secrets
secrets = get_secret("dev/rag-demo/all", "ap-southeast-1")

# Configuration from secrets
GOOGLE_API_KEY = secrets["GOOGLE_API_KEY"]
OPENSEARCH_DOMAIN_ENDPOINT = secrets["OPENSEARCH_HOST"]
OPENSEARCH_AWS_ACCESS_KEY_ID = secrets["AWS_ACCESS_KEY_ID"]
OPENSEARCH_AWS_SECRET_ACCESS_KEY = secrets["AWS_SECRET_ACCESS_KEY"]
OPENSEARCH_REGION = secrets["OP_AWS_REGION"]

S3_REGION = secrets["S3_AWS_REGION"]
S3_BUCKET_NAME = os.environ.get["S3_BUCKET_NAME"]
# S3_BUCKET_NAME = secrets["S3_BUCKET_NAME"]

S3_AWS_ACCESS_KEY_ID = secrets["AWS_ACCESS_KEY_ID"]
S3_AWS_SECRET_ACCESS_KEY = secrets["AWS_SECRET_ACCESS_KEY"]

INDEX_NAME = secrets["GOOGLE_INDEX_NAME"]
EMBEDDING_MODEL_ID = secrets.get("EMBEDDING_MODEL_ID", "models/embedding-001")

VECTOR_DIMENSION = 768
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 20


# Initialize clients
s3_client = boto3.client(
    "s3",
    region_name=S3_REGION,
    aws_access_key_id=S3_AWS_ACCESS_KEY_ID,
    aws_secret_access_key=S3_AWS_SECRET_ACCESS_KEY,
)

genai.configure(api_key=GOOGLE_API_KEY)


class OpenSearchStore:
    def __init__(self):
        """Initialize OpenSearch store with Google AI embeddings and AWS authentication"""
        self.embeddings = GoogleGenerativeAIEmbeddings(model=EMBEDDING_MODEL_ID)
        self.client = self._initialize_client()

    def _initialize_client(self) -> OpenSearchVectorSearch:
        """Initialize OpenSearch client with AWS authentication"""
        awsauth = AWS4Auth(
            OPENSEARCH_AWS_ACCESS_KEY_ID,
            OPENSEARCH_AWS_SECRET_ACCESS_KEY,
            OPENSEARCH_REGION,
            "aoss",
        )

        return OpenSearchVectorSearch(
            embedding_function=self.embeddings,
            index_name=INDEX_NAME,
            opensearch_url=OPENSEARCH_DOMAIN_ENDPOINT,
            port=443,
            http_auth=awsauth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
        )

    def add_documents(self, documents: List[Dict[str, Any]]) -> bool:
        """Add documents to OpenSearch index"""
        try:
            self.client.add_documents(documents=documents)
            logger.info(f"Added {len(documents)} documents to OpenSearch")
            return True
        except Exception as e:
            logger.error(f"Error adding documents: {str(e)}")
            return False


def process_file(bucket_name: str, key: str, vector_store: OpenSearchStore) -> bool:
    """Process individual file and store in vector store"""
    try:
        loader = S3FileLoader(bucket_name, key)
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=CHUNK_SIZE,
            chunk_overlap=CHUNK_OVERLAP,
            length_function=len,
            is_separator_regex=False,
        )
        documents = loader.load_and_split(text_splitter=text_splitter)
        return vector_store.add_documents(documents)
    except Exception as e:
        logger.error(f"Error processing {key}: {str(e)}")
        return False


def handler(event: Dict[str, Any], context: Any) -> None:
    """
    Lambda handler to process SQS messages, generate embeddings, and index to OpenSearch
    """
    # Initialize vector store
    vector_store = OpenSearchStore()

    # Process each SQS record
    for record in event["Records"]:
        try:
            # Parse metadata from SQS message
            metadata = json.loads(record["body"])

            # Process file
            if process_file(metadata["bucket"], metadata["key"], vector_store):
                logger.info(f"Successfully processed and indexed {metadata['key']}")
            else:
                logger.warning(f"Failed to process {metadata['key']}")

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            continue


# Local testing
if __name__ == "__main__":
    # Define the test event
    test_event = {
        "Records": [
            {
                "body": json.dumps(
                    {
                        "bucket": "rag-demo-manual",
                        "key": "20241129/dataset.txt",
                        "size": 17927,
                        "lastModified": "2024-11-28T16:06:04+00:00",
                        "contentType": "text/plain",
                        "path": "20241129",
                    }
                )
            }
        ]
    }

    # Mock context (can be empty for local testing)
    mock_context = {}

    # Call the handler function
    handler(test_event, mock_context)
