import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fs from 'fs';

interface OpensearchBedrockRagCdkStackProps extends cdk.StackProps {
  vpc: ec2.Vpc
  environment: string
  projectName: string
}

export class OpensearchBedrockRagCdkStack extends cdk.Stack {
  OpenSearchEndpoint: string
  VectorIndexName: string
  VectorFieldName: string

  constructor(scope: Construct, id: string, props?: OpensearchBedrockRagCdkStackProps) {
    super(scope, id, props);

    // Define the IAM role
    const role = new iam.Role(this, 'OpenSearchServerlessAccessRole', {
      roleName: 'OpenSearchServerlessAccessRole',
      assumedBy: new iam.ServicePrincipal('es.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonOpenSearchServiceFullAccess')
      ]
    });

    new cdk.CfnOutput(this, 'OpenSearchServerlessAccessRoleArn', {
      value: role.roleArn
    });

    const CollectionName = `${props?.projectName}-collection`
    const vectorIndexName = `${CollectionName}-index`


    // const secConfig = new opensearchserverless.CfnSecurityConfig(this, 'OpenSearchServerlessSecurityConfig', {
    //   name: `${CollectionName}-config`,
    //   type: 'iamidentitycenter',
    //   description: 'IAM-based authentication for OpenSearch Serverless'
    // });


    // Define the encryption policy
    const encPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'EncryptionPolicy', {
      name: 'rag-encryption-policy',
      policy: JSON.stringify({
        Rules: [
          {
            ResourceType: "collection",
            Resource: [`collection/${CollectionName}`]
          }
        ],
        AWSOwnedKey: true
      }),
      type: 'encryption'
    });

    // Network policy is required so that the dashboard can be viewed!
    const netPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: 'rag-network-policy',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${CollectionName}`],
            },
            {
              ResourceType: 'dashboard',
              Resource: [`collection/${CollectionName}`],
            },
          ],
          AllowFromPublic: true,
        },
      ]),
      type: 'network',
    });


    // Create the OpenSearch Serverless collection
    const collection = new opensearchserverless.CfnCollection(this, 'OpenSearchCollection', {
      name: CollectionName,
      type: 'VECTORSEARCH',
    });

    // Create Lambda function for custom resource
    const createIndexLambda = new lambda.Function(this, 'CreateIndexLambda', {
      functionName: 'CreateIndexFunction',
      role: new iam.Role(this, 'CreateIndexLambdaRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        roleName: 'CreateIndex-LambdaRole',
        // Add any additional permissions required by your function
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonOpenSearchServiceFullAccess'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ]
        // Add any additional permissions required by your function
      }),
      handler: 'index.handler',
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda'), // Path to your Lambda function code
      timeout: cdk.Duration.minutes(5),
      initialPolicy: [
        new iam.PolicyStatement({
          actions: ['aoss:*', 'es:*'],
          resources: ['*']
        })
      ]
    });


    // Define the data access policy
    const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'DataAccessPolicy', {
      name: 'rag-data-access-policy',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${CollectionName}`],
              Permission: [
                'aoss:CreateCollectionItems',
                'aoss:DeleteCollectionItems',
                'aoss:UpdateCollectionItems',
                'aoss:DescribeCollectionItems',
              ],
            },
            {
              ResourceType: 'index',
              Resource: [`index/${CollectionName}/*`],
              Permission: [
                'aoss:CreateIndex',
                'aoss:DeleteIndex',
                'aoss:UpdateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
              ],
            },
          ],
          Principal: [
            role.roleArn,
            `arn:aws:iam::${this.account}:root`,
            //`arn:aws:iam::${this.account}:role/CreateIndex-LambdaRole`,
            createIndexLambda.role?.roleArn,
          ],
        },
      ]),
      type: 'data',
      description: 'Data access policy for rag-collection',
    });

    // Ensure the collection depends on the policies
    collection.addDependency(dataAccessPolicy);
    collection.addDependency(encPolicy);
    collection.addDependency(netPolicy);


    const Endpoint = `${collection.attrId}.${cdk.Stack.of(this).region}.aoss.amazonaws.com`;

    const vectorIndex = new cr.AwsCustomResource(this, 'vectorIndexResource', {
      installLatestAwsSdk: true,
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Create',
            CollectionName: collection.name,
            IndexName: vectorIndexName,
            VectorDimension: 1536,
            Endpoint: Endpoint,
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('vectorIndex'),
      },
      onDelete: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Delete',
            CollectionName: collection.name,
            IndexName: vectorIndexName,
            Endpoint: Endpoint,
          }),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [createIndexLambda.functionArn],
        }),
      ]),
      timeout: cdk.Duration.minutes(5),
    });

    const geminiVectorIndex = new cr.AwsCustomResource(this, 'GeminiVectorIndexResource', {
      installLatestAwsSdk: true,
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Create',
            CollectionName: collection.name,
            IndexName: 'aoss-index',
            VectorDimension: 768,
            Endpoint: Endpoint,
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('gemini-vector-index'),
      },
      onDelete: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Delete',
            CollectionName: collection.name,
            IndexName: 'aoss-index',
            Endpoint: Endpoint,
          }),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [createIndexLambda.functionArn],
        }),
      ]),
    });

    const claudeVectorIndex = new cr.AwsCustomResource(this, 'claudeVectorIndexResource', {
      installLatestAwsSdk: true,
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Create',
            CollectionName: collection.name,
            IndexName: 'claude-embedding-index',
            VectorDimension: 1024,
            Endpoint: Endpoint,
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('claude-vector-index'),
      },
      onDelete: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: createIndexLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Delete',
            CollectionName: collection.name,
            IndexName: 'claude-embedding-index',
            Endpoint: Endpoint,
          }),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [createIndexLambda.functionArn],
        }),
      ]),
    });

    // Ensure vectorIndex depends on collection
    vectorIndex.node.addDependency(collection);
    vectorIndex.node.addDependency(createIndexLambda);

    geminiVectorIndex.node.addDependency(collection);
    geminiVectorIndex.node.addDependency(createIndexLambda);

    claudeVectorIndex.node.addDependency(collection);
    claudeVectorIndex.node.addDependency(createIndexLambda);

    this.OpenSearchEndpoint = Endpoint
    this.VectorIndexName = vectorIndexName
    this.VectorFieldName = 'vector_field'

    new cdk.CfnOutput(this, 'aoss_env', {
      value: `export opensearch_host=${Endpoint}\nexport vector_index_name=${vectorIndexName}\nexport vector_field_name=vector_field`
    });



  }
}
