#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpensearchBedrockRagCdkStack } from '../lib/opensearch-bedrock-rag-cdk-stack';
import { EcsFargateCdkStack } from '../lib/ecs-fargate-cdk-stack';

// Create a new app
const app = new cdk.App();

// Create the stack
const openSearchStack = new OpensearchBedrockRagCdkStack(app, 'OpensearchBedrockRagCdkStack', {
});

// Create the ECS Fargate stack
new EcsFargateCdkStack(app, 'EcsFargateCdkStack', {
  OpenSearchEndpoint: openSearchStack.OpenSearchEndpoint,
  VectorFieldName: openSearchStack.VectorFieldName,
  VectorIndexName: openSearchStack.VectorIndexName
});