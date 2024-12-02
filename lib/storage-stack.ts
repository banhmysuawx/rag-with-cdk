import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

interface StorageStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
    environment: string;
    projectName: string;
    allowedIpRange?: string;
}

export class StorageStack extends cdk.Stack {
    public readonly bucket: s3.Bucket;
    public readonly database: rds.DatabaseInstance;
    public readonly table: dynamodb.Table;
    public readonly dbSecret: secretsmanager.Secret;

    constructor(scope: Construct, id: string, props: StorageStackProps) {
        super(scope, id, props);

        // Add global tags
        cdk.Tags.of(this).add('Project', props.projectName);
        cdk.Tags.of(this).add('Environment', props.environment);

        // Input validation
        if (!props.vpc) {
            throw new Error('VPC is required for StorageStack');
        }

        // Create S3 Bucket
        const bucket = new s3.Bucket(this, 'MyDataBucket', {
            bucketName: `${props.projectName}-${props.environment}-rag-data-bucket-${cdk.Stack.of(this).account}`,
            versioned: false,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Create RDS credentials in Secrets Manager
        const databaseCredentialsSecret = new secretsmanager.Secret(this, 'DBCredentialsSecret', {
            secretName: `/${props.environment}/${props.projectName}/db-credentials`,
            generateSecretString: {
                secretStringTemplate: JSON.stringify({
                    username: 'dbadmin',
                }),
                excludePunctuation: true,
                includeSpace: false,
                passwordLength: 24,
                generateStringKey: 'password'
            },
        });

        // Create Security Group for RDS using imported VPC
        const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
            vpc: props.vpc,
            description: 'Security group for RDS instance',
            allowAllOutbound: true,
        });

        if (props.allowedIpRange) {
            dbSecurityGroup.addIngressRule(
                ec2.Peer.ipv4(props.allowedIpRange),
                ec2.Port.tcp(5432),
                'Restrict PostgreSQL access to specific IP range'
            );
        }

        dbSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
            ec2.Port.tcp(5432),
            'Allow PostgreSQL access from within VPC'
        );


        // Create RDS Instance
        const database = new rds.DatabaseInstance(this, 'MyDatabase', {
            engine: rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.VER_16
            }),
            vpc: props.vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            instanceType: ec2.InstanceType.of(
                ec2.InstanceClass.T3,
                ec2.InstanceSize.MICRO
            ),
            securityGroups: [dbSecurityGroup],
            databaseName: 'auth_db',
            allocatedStorage: 20,
            maxAllocatedStorage: 30,
            deleteAutomatedBackups: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
        });

        // Create DynamoDB Table
        const table = new dynamodb.Table(this, 'MyTable', {
            partitionKey: {
                name: 'user_id',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'timestamp',
                type: dynamodb.AttributeType.NUMBER
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Add outputs
        new cdk.CfnOutput(this, 'BucketName', {
            value: bucket.bucketName,
            description: 'S3 Bucket Name',
        });

        new cdk.CfnOutput(this, 'DatabaseEndpoint', {
            value: database.instanceEndpoint.hostname,
            description: 'RDS Endpoint',
        });

        new cdk.CfnOutput(this, 'DynamoDBTableName', {
            value: table.tableName,
            description: 'DynamoDB Table Name',
        });

        new cdk.CfnOutput(this, 'DatabaseSecretArn', {
            value: databaseCredentialsSecret.secretArn,
            description: 'Database Secret ARN',
        });

        // Store references
        this.bucket = bucket;
        this.database = database;
        this.table = table;
        this.dbSecret = databaseCredentialsSecret;
    }
}
