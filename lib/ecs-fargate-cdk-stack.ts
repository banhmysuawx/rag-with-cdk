import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface ClusterProps extends cdk.StackProps {
  environment: string,
  projectName: string,
  OpenSearchEndpoint: string,
  VectorIndexName: string,
  VectorFieldName: string,
  ecrRepositoryName: string,
  vpc: ec2.Vpc,
  s3BucketName: string,
  dbName: string,
  dbHost: string,
  dynamoTableName: string,
  dbSecret: secretsmanager.Secret,
}

export class EcsFargateCdkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id, props);

    // Add global tags
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Environment', props.environment);

    const repository = ecr.Repository.fromRepositoryName(
      this,
      'MyRepository',
      props.ecrRepositoryName
    );

    // Dynamic cluster name
    const clusterName = `${props.projectName}-${props.environment}-cluster`;

    // Create an ECS Cluster named "bedrock-ecs-cluster"
    const cluster = new ecs.Cluster(this, 'MyEcsCluster', {
      vpc: props.vpc,
      clusterName: clusterName,
    });


    // Build and push Docker image to ECR
    // const appImageAsset = new DockerImageAsset(this, 'MyStreamlitAppImage', {
    //   directory: './lib/docker',
    //   platform: Platform.LINUX_ARM64, // Specify the x86 architecture
    // });

    // Reference existing secret by ARN or name
    const existingSecret = secretsmanager.Secret.fromSecretNameV2(this, 'ImportedSecret',
      'dev/rag-demo/all'
    );

    // // Retrieve the existing secret value
    // const existingSecretValue = existingSecret.secretValue.unsafeUnwrap();
    // const existingSecretObject = existingSecretValue ? JSON.parse(existingSecretValue) : {};

    // // Add the new key-value pair
    // existingSecretObject['S3_BUCKET_NAME'] = props.s3BucketName;

    // // Create a new secret with the combined values
    // const updatedSecret = new secretsmanager.Secret(this, 'UpdatedSecret', {
    //   secretName: existingSecret.secretName, // Use the same name if you want to overwrite
    //   secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify(existingSecretObject)),
    // });


    // Create a new Fargate service with the image from ECR and specify the service name
    const appService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'MyFargateService', {
      cluster,
      serviceName: `${props.projectName}-${props.environment}-service`,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskImageOptions: {
        // image: ecs.ContainerImage.fromDockerImageAsset(appImageAsset),
        image: ecs.ContainerImage.fromEcrRepository(repository, 'latest'),
        containerPort: 8501,
        environment: {
          'opensearch_host': props.OpenSearchEndpoint,
          'vector_index_name': props.VectorIndexName,
          'vector_field_name': props.VectorFieldName,

          'OPENSEARCH_HOST': props.OpenSearchEndpoint,
          'OP_AWS_REGION': 'ap-southeast-1',

          'RDS_DB_NAME': props.dbName,
          'RDS_HOSTNAME': props.dbHost,
          'RDS_REGION': 'ap-southeast-1',

          'DYNAMODB_TABLE_NAME': props.dynamoTableName,
          'DYNAMODB_AWS_REGION': 'ap-southeast-1',

          'S3_BUCKET_NAME': props.s3BucketName,
          'S3_AWS_REGION': 'ap-southeast-1',

          'BEDROCK_REGION': 'ap-southeast-1',
          'BEDROCK_EMBEDDING_MODEL_ID': 'amazon.titan-embed-text-v2:0',
          'BEDROCK_INDEX_NAME': 'amazon.titan-embed-text-v2',
          'BEDROCK_VECTOR_DIMENSION': '1024',
          'AUTH_DB_SECRET_ARN': props.dbSecret.secretArn,

        },
        secrets: {
          'GOOGLE_API_KEY': ecs.Secret.fromSecretsManager(existingSecret, 'GOOGLE_API_KEY'),
          'GOOGLE_INDEX_NAME': ecs.Secret.fromSecretsManager(existingSecret, 'GOOGLE_INDEX_NAME'),
          'GOOGLE_EMBEDDING_MODEL_ID': ecs.Secret.fromSecretsManager(existingSecret, 'GOOGLE_EMBEDDING_MODEL_ID'),
          'GOOGLE_VECTOR_DIMENSION': ecs.Secret.fromSecretsManager(existingSecret, 'GOOGLE_VECTOR_DIMENSION'),
          'AWS_ACCESS_KEY_ID': ecs.Secret.fromSecretsManager(existingSecret, 'AWS_ACCESS_KEY_ID'),
          'AWS_SECRET_ACCESS_KEY': ecs.Secret.fromSecretsManager(existingSecret, 'AWS_SECRET_ACCESS_KEY'),

          'EMBEDDING_CHUNK_SIZE': ecs.Secret.fromSecretsManager(existingSecret, 'EMBEDDING_CHUNK_SIZE'),
          'EMBEDDING_CHUNK_OVERLAP': ecs.Secret.fromSecretsManager(existingSecret, 'EMBEDDING_CHUNK_OVERLAP'),

        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: `${props.projectName}-${props.environment}-logs`,
          logRetention: logs.RetentionDays.ONE_WEEK
        }),
      },
      publicLoadBalancer: true,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true
    });
    //

    // Set AutoScaling policy
    const scaling = appService.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 3 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
    });

    const bedrock_iam = new iam.Policy(this, 'BedrockPermissionsPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "bedrock:InvokeModel*",
            "bedrock:Converse*",
            "aoss:*"
          ],
          resources: [
            "arn:aws:bedrock:us-east-1::foundation-model/amazon*",
            "*"
          ],
        }),
      ],
    })

    appService.taskDefinition.addToExecutionRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:CreateControlChannel",
        'secretsmanager:GetSecretValue',
        'kms:Decrypt'
      ],
      resources: ["*"] //adjust as per your need
    }));

    // Create custom header for CloudFront origin
    const customHeaderName = 'X-Verify-Origin';
    const customHeaderValue = `${this.stackName}-StreamLitCloudFrontDistribution`;

    // Create CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'StreamLitCloudFrontDistribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(appService.loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
          originPath: '/',
          customHeaders: {
            [customHeaderName]: customHeaderValue,
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        compress: false,
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      comment: 'CloudFront distribution for Streamlit frontend application',
    });


    // Add the Bedrock permissions to the task role
    appService.taskDefinition.taskRole?.attachInlinePolicy(bedrock_iam)

    // Grant ECR repository permissions for the task execution role
    // appImageAsset.repository.grantPullPush(appService.taskDefinition.executionRole!);

    // Grant ECR repository permissions for the task execution role
    repository.grantPull(appService.taskDefinition.executionRole!);

    // Grant permissions for CloudWatch Logs
    const logGroup = new logs.LogGroup(this, 'MyLogGroup', {
      // logGroupName: '/ecs/ecs-bedrock-service',
      logGroupName: `/${props.projectName}-${props.environment}-logs`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Grant read permissions to the Fargate task
    existingSecret.grantRead(appService.taskDefinition.taskRole);

    // Output the CloudFront URL
    new cdk.CfnOutput(this, 'StreamlitURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'The CloudFront URL of the Streamlit application',
    });

    logGroup.grantWrite(appService.taskDefinition.executionRole!);

  }
}
