#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BaseStack } from '../lib/base-stack';
import { OpensearchBedrockRagCdkStack } from '../lib/opensearch-bedrock-rag-cdk-stack';
import { EcsFargateCdkStack } from '../lib/ecs-fargate-cdk-stack';
import { StorageStack } from '../lib/storage-stack';
import { IngestStack } from '../lib/ingest-stack';

const app = new cdk.App();

// environment and projectName are used in StorageStack
const environment = 'dev';
const projectName = 'rag-demo';

// Create base infrastructure
const baseStack = new BaseStack(app, 'BaseStack', {
  environment: environment,
  projectName: projectName
});

// Create OpenSearch stack
const openSearchStack = new OpensearchBedrockRagCdkStack(app, 'OpensearchBedrockRagCdkStack', {
  vpc: baseStack.vpc,
  environment: environment,
  projectName: projectName
});

// Create Storage stack  
const storageStack = new StorageStack(app, 'StorageStack', {
  vpc: baseStack.vpc,
  environment: environment,
  projectName: projectName
});

// Create ECS stack
new EcsFargateCdkStack(app, 'EcsFargateCdkStack', {
  environment: environment,
  projectName: projectName,
  vpc: baseStack.vpc,
  OpenSearchEndpoint: openSearchStack.OpenSearchEndpoint,
  VectorFieldName: openSearchStack.VectorFieldName,
  VectorIndexName: openSearchStack.VectorIndexName,
  ecrRepositoryName: 'bedrock-ecs-repository',
  s3BucketName: storageStack.bucket?.bucketName,
  dbName: 'auth_db',
  dbHost: storageStack.database?.instanceEndpoint?.hostname,
  dynamoTableName: storageStack.table?.tableName,
  dbSecret: storageStack.dbSecret
});

// Create ingest stack with bastion reference
new IngestStack(app, 'IngestStack', {
  vpc: baseStack.vpc,
  bastion: baseStack.bastionHost,
  s3Bucket: storageStack.bucket,
  environment: environment,
  projectName: projectName,
});


// baseStack.addDependency(ingestStack);