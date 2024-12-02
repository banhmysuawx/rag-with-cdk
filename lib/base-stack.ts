// lib/base-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface BaseStackProps extends cdk.StackProps {
    environment: string;
    projectName: string;
}

export class BaseStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly publicSubnets: ec2.SubnetSelection;
    public readonly privateSubnets: ec2.SubnetSelection;
    public readonly isolatedSubnets: ec2.SubnetSelection;
    public readonly bastionHost: ec2.BastionHostLinux;

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        // Add global tags
        cdk.Tags.of(this).add('Project', props.projectName);
        cdk.Tags.of(this).add('Environment', props.environment);

        this.vpc = new ec2.Vpc(this, 'SharedVpc', {
            maxAzs: 2,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
                {
                    cidrMask: 24,
                    name: 'Isolated',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                }
            ],
            natGateways: 1,
        });

        // Create security group for bastion host
        const bastionSecurityGroup = new ec2.SecurityGroup(this, 'BastionSecurityGroup', {
            vpc: this.vpc,
            description: 'Security group for Bastion Host',
            allowAllOutbound: true,
        });

        // Allow NFS traffic from bastion
        bastionSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(2049),
            'Allow NFS traffic'
        );

        const bastionHost = new ec2.BastionHostLinux(this, 'BastionHost', {
            vpc: this.vpc,
            subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
            instanceName: `${props.projectName}-${props.environment}-bastion`,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            // set Am
        });

        // Cài đặt PostgreSQL client
        bastionHost.instance.addUserData(
            'yum update -y',
            'yum install -y postgresql16'
        );


        // Add required policies for EFS access
        bastionHost.instance.role.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
        );
        bastionHost.instance.role.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemClientFullAccess')
        );

        bastionHost.instance.role.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                'elasticfilesystem:ClientMount',
                'elasticfilesystem:ClientWrite',
                'elasticfilesystem:DescribeMountTargets'
            ],
            resources: ['*']
        }));

        this.publicSubnets = { subnets: this.vpc.publicSubnets };
        this.privateSubnets = { subnets: this.vpc.privateSubnets };
        this.isolatedSubnets = { subnets: this.vpc.isolatedSubnets };
        this.bastionHost = bastionHost;

        // Outputs
        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpc.vpcId,
            description: 'VPC ID',
            exportName: 'SharedVpcId',
        });
    }
}
