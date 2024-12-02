import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as path from 'path';

interface IngestStackProps extends cdk.StackProps {
    vpc: ec2.IVpc;
    s3Bucket: s3.IBucket;
    environment: string;
    projectName: string;
    bastion: ec2.BastionHostLinux;  // Add bastion to props
    secretArn?: string;
}

export class IngestStack extends cdk.Stack {
    public readonly metadataProcessor: lambda.Function;
    public readonly ingestionProcessor: lambda.Function;
    public readonly queue: sqs.Queue;

    constructor(scope: Construct, id: string, props: IngestStackProps) {
        super(scope, id, props);

        // Add global tags
        this.addTags(props);

        // Create infrastructure
        this.queue = this.createQueue();
        const fileSystem = this.createFileSystem(props);
        const accessPoint = this.createEfsAccessPoint(fileSystem);

        // Create Lambda functions
        this.metadataProcessor = this.createMetadataProcessor(props);
        this.ingestionProcessor = this.createIngestionProcessor(props, accessPoint);

        // Set up permissions and event sources
        this.setupPermissions(props, fileSystem);

        // Create EventBridge rule
        this.createMonthlyTrigger();
    }

    private addTags(props: IngestStackProps): void {
        cdk.Tags.of(this).add('Project', props.projectName);
        cdk.Tags.of(this).add('Environment', props.environment);
    }

    private createQueue(): sqs.Queue {
        return new sqs.Queue(this, 'IngestionQueue', {
            visibilityTimeout: cdk.Duration.seconds(900),
            retentionPeriod: cdk.Duration.days(4),
            deadLetterQueue: {
                queue: new sqs.Queue(this, 'DeadLetterQueue'),
                maxReceiveCount: 3
            }
        });
    }

    private createFileSystem(props: IngestStackProps): efs.FileSystem {
        // Create security group for EFS
        const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSecurityGroup', {
            vpc: props.vpc,
            description: 'Security group for EFS',
            allowAllOutbound: true
        });

        // Create the file system with security group
        const fileSystem = new efs.FileSystem(this, 'EfsFileSystem', {
            vpc: props.vpc,
            securityGroup: efsSecurityGroup,
            // vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
            encrypted: true,
            enableAutomaticBackups: true,
            // Add file system policy to allow root access
            fileSystemPolicy: new iam.PolicyDocument({
                statements: [
                    new iam.PolicyStatement({
                        principals: [new iam.AnyPrincipal()],
                        actions: [
                            'elasticfilesystem:ClientRootAccess',
                            'elasticfilesystem:ClientWrite',
                        ],
                        resources: ['*'],
                        conditions: {
                            Bool: {
                                'elasticfilesystem:AccessedViaMountTarget': 'true'
                            }
                        }
                    })
                ]
            })
        });

        // Allow NFS access from bastion's security group
        efsSecurityGroup.addIngressRule(
            props.bastion.connections.securityGroups[0],
            ec2.Port.tcp(2049),
            'Allow NFS access from Bastion'
        );

        // Output the EFS ID for use in other stacks
        new cdk.CfnOutput(this, 'EfsFileSystemId', {
            value: fileSystem.fileSystemId,
            description: 'EFS File System ID',
            exportName: 'EfsFileSystemId',
        });

        return fileSystem;
    }



    private createEfsAccessPoint(fileSystem: efs.FileSystem): efs.AccessPoint {
        return fileSystem.addAccessPoint('AccessPoint', {
            path: '/lambda',
            createAcl: {
                ownerUid: '1001',
                ownerGid: '1001',
                permissions: '750',
            },
            posixUser: {
                uid: '1001',
                gid: '1001',
            },
        });
    }

    private createMetadataProcessor(props: IngestStackProps): lambda.Function {
        const securityGroup = new ec2.SecurityGroup(this, 'MetadataProcessorSG', {
            vpc: props.vpc,
            allowAllOutbound: false,
            description: 'Security group for Metadata Processor Lambda'
        });

        // Add specific egress rules
        securityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),  // HTTPS
            'Allow HTTPS outbound traffic'
        );

        // Allow VPC endpoints access
        securityGroup.addEgressRule(
            ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
            ec2.Port.tcp(443),
            'Allow VPC Endpoints access'
        );


        const lambdaFunction = new lambda.Function(this, 'MetadataProcessorLambda', {
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'metadata_processor.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            vpc: props.vpc,
            securityGroups: [securityGroup],
            environment: {
                S3_BUCKET_NAME: props.s3Bucket.bucketName,
                QUEUE_URL: this.queue.queueUrl,
            },
            timeout: cdk.Duration.minutes(5),
            memorySize: 256,
            retryAttempts: 2,
        });

        props.s3Bucket.grantRead(lambdaFunction);
        this.queue.grantSendMessages(lambdaFunction);

        return lambdaFunction;
    }

    private createIngestionProcessor(props: IngestStackProps, accessPoint: efs.AccessPoint): lambda.Function {
        const securityGroup = new ec2.SecurityGroup(this, 'IngestionProcessorSG', {
            vpc: props.vpc,
            allowAllOutbound: false,
            description: 'Security group for Ingestion Processor Lambda'
        });

        // Add specific egress rules
        securityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),  // HTTPS
            'Allow HTTPS outbound traffic'
        );

        // Add EFS egress rule
        securityGroup.addEgressRule(
            ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
            ec2.Port.tcp(2049),  // NFS/EFS
            'Allow EFS access'
        );

        // Allow VPC endpoints access
        securityGroup.addEgressRule(
            ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
            ec2.Port.tcp(443),
            'Allow VPC Endpoints access'
        );


        const lambdaFunction = new lambda.Function(this, 'IngestionProcessorLambda', {
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'ingestion_processor.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            vpc: props.vpc,
            securityGroups: [securityGroup],
            filesystem: lambda.FileSystem.fromEfsAccessPoint(accessPoint, '/mnt/lambda'),
            timeout: cdk.Duration.minutes(15),
            memorySize: 1024,
            retryAttempts: 2,
            environment: {
                QUEUE_URL: this.queue.queueUrl,
                S3_BUCKET_NAME: props.s3Bucket.bucketName,
            },
        });

        return lambdaFunction;
    }


    private setupPermissions(props: IngestStackProps, fileSystem: efs.FileSystem): void {
        // S3 permissions
        props.s3Bucket.grantRead(this.ingestionProcessor);

        // EFS permissions
        this.ingestionProcessor.connections.allowTo(
            fileSystem,
            ec2.Port.tcp(2049),
            'Allow Lambda to access EFS'
        );

        fileSystem.grant(this.ingestionProcessor.role!,
            'elasticfilesystem:ClientMount',
            'elasticfilesystem:ClientWrite'
        );

        // Secrets Manager permissions
        if (props.secretArn) {
            this.ingestionProcessor.addToRolePolicy(new iam.PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [props.secretArn],
            }));
        }
    }

    private createMonthlyTrigger(): void {
        const monthlyRule = new events.Rule(this, 'MonthlyTriggerRule', {
            schedule: events.Schedule.cron({ day: '1', hour: '0', minute: '0' }),
            description: 'Triggers metadata processor on the first of each month',
        });

        monthlyRule.addTarget(new targets.LambdaFunction(this.metadataProcessor));
    }
}


