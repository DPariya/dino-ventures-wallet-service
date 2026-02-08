# AWS Deployment Guide

This guide walks through deploying the Dino Ventures Wallet Service to AWS.

## Architecture Overview

```
Internet
    ↓
Application Load Balancer (ALB)
    ↓
ECS Fargate Cluster
    ├─ Wallet Service Container (Auto-scaling)
    └─ Wallet Service Container
    ↓
Amazon RDS PostgreSQL (Multi-AZ)
```

## Prerequisites

- AWS Account
- AWS CLI configured
- Docker installed locally
- Domain name (optional, for HTTPS)

## Deployment Steps

### 1. Create RDS PostgreSQL Database

```bash
# Create RDS instance
aws rds create-db-instance \
    --db-instance-identifier wallet-service-db \
    --db-instance-class db.t3.medium \
    --engine postgres \
    --engine-version 15.4 \
    --master-username wallet_admin \
    --master-user-password YOUR_SECURE_PASSWORD \
    --allocated-storage 20 \
    --storage-type gp3 \
    --vpc-security-group-ids sg-xxxxxx \
    --db-subnet-group-name your-subnet-group \
    --backup-retention-period 7 \
    --multi-az \
    --storage-encrypted \
    --enable-performance-insights \
    --performance-insights-retention-period 7

# Wait for database to be available
aws rds wait db-instance-available \
    --db-instance-identifier wallet-service-db
```

### 2. Initialize Database Schema

```bash
# Get RDS endpoint
RDS_ENDPOINT=$(aws rds describe-db-instances \
    --db-instance-identifier wallet-service-db \
    --query 'DBInstances[0].Endpoint.Address' \
    --output text)

# Run schema and seed from local machine (ensure security group allows your IP)
psql "postgresql://wallet_admin:YOUR_PASSWORD@$RDS_ENDPOINT:5432/wallet_service" < schema.sql
psql "postgresql://wallet_admin:YOUR_PASSWORD@$RDS_ENDPOINT:5432/wallet_service" < seed.sql
```

### 3. Create ECR Repository

```bash
# Create ECR repository
aws ecr create-repository \
    --repository-name wallet-service \
    --region us-east-1

# Get ECR repository URI
ECR_URI=$(aws ecr describe-repositories \
    --repository-names wallet-service \
    --query 'repositories[0].repositoryUri' \
    --output text)

echo "ECR Repository: $ECR_URI"
```

### 4. Build and Push Docker Image

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-1 | \
    docker login --username AWS --password-stdin $ECR_URI

# Build Docker image
docker build -t wallet-service:latest .

# Tag image
docker tag wallet-service:latest $ECR_URI:latest

# Push to ECR
docker push $ECR_URI:latest
```

### 5. Create ECS Cluster

```bash
# Create ECS cluster
aws ecs create-cluster \
    --cluster-name wallet-service-cluster \
    --capacity-providers FARGATE FARGATE_SPOT \
    --region us-east-1
```

### 6. Create Task Definition

Create `ecs-task-definition.json`:

```json
{
  "family": "wallet-service",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::YOUR_ACCOUNT:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::YOUR_ACCOUNT:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "wallet-service",
      "image": "YOUR_ECR_URI:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        },
        {
          "name": "PORT",
          "value": "3000"
        },
        {
          "name": "DB_HOST",
          "value": "YOUR_RDS_ENDPOINT"
        },
        {
          "name": "DB_PORT",
          "value": "5432"
        },
        {
          "name": "DB_NAME",
          "value": "wallet_service"
        },
        {
          "name": "DB_USER",
          "value": "wallet_admin"
        }
      ],
      "secrets": [
        {
          "name": "DB_PASSWORD",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:YOUR_ACCOUNT:secret:wallet-service/db-password"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/wallet-service",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "node -e \"require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})\""
        ],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

Register task definition:

```bash
aws ecs register-task-definition \
    --cli-input-json file://ecs-task-definition.json
```

### 7. Create Application Load Balancer

```bash
# Create ALB
aws elbv2 create-load-balancer \
    --name wallet-service-alb \
    --subnets subnet-xxxxx subnet-yyyyy \
    --security-groups sg-xxxxxx \
    --scheme internet-facing \
    --type application

# Create target group
aws elbv2 create-target-group \
    --name wallet-service-tg \
    --protocol HTTP \
    --port 3000 \
    --vpc-id vpc-xxxxx \
    --target-type ip \
    --health-check-path /health \
    --health-check-interval-seconds 30 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3

# Create listener
aws elbv2 create-listener \
    --load-balancer-arn arn:aws:elasticloadbalancing:... \
    --protocol HTTP \
    --port 80 \
    --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:...
```

### 8. Create ECS Service

```bash
aws ecs create-service \
    --cluster wallet-service-cluster \
    --service-name wallet-service \
    --task-definition wallet-service:1 \
    --desired-count 2 \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[subnet-xxxxx,subnet-yyyyy],securityGroups=[sg-xxxxxx],assignPublicIp=ENABLED}" \
    --load-balancers targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=wallet-service,containerPort=3000 \
    --health-check-grace-period-seconds 60
```

### 9. Configure Auto Scaling

```bash
# Register scalable target
aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount \
    --resource-id service/wallet-service-cluster/wallet-service \
    --min-capacity 2 \
    --max-capacity 10

# Create scaling policy (CPU-based)
aws application-autoscaling put-scaling-policy \
    --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount \
    --resource-id service/wallet-service-cluster/wallet-service \
    --policy-name cpu-scaling-policy \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration file://scaling-policy.json
```

`scaling-policy.json`:
```json
{
  "TargetValue": 70.0,
  "PredefinedMetricSpecification": {
    "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
  },
  "ScaleInCooldown": 300,
  "ScaleOutCooldown": 60
}
```

### 10. Store Secrets in AWS Secrets Manager

```bash
# Store database password
aws secretsmanager create-secret \
    --name wallet-service/db-password \
    --secret-string "YOUR_SECURE_DATABASE_PASSWORD"
```

### 11. Set Up CloudWatch Alarms

```bash
# High error rate alarm
aws cloudwatch put-metric-alarm \
    --alarm-name wallet-service-high-errors \
    --alarm-description "Alert when error rate is high" \
    --metric-name HTTPCode_Target_5XX_Count \
    --namespace AWS/ApplicationELB \
    --statistic Sum \
    --period 300 \
    --evaluation-periods 2 \
    --threshold 10 \
    --comparison-operator GreaterThanThreshold \
    --dimensions Name=LoadBalancer,Value=app/wallet-service-alb/...

# High latency alarm
aws cloudwatch put-metric-alarm \
    --alarm-name wallet-service-high-latency \
    --alarm-description "Alert when latency is high" \
    --metric-name TargetResponseTime \
    --namespace AWS/ApplicationELB \
    --statistic Average \
    --period 300 \
    --evaluation-periods 2 \
    --threshold 1.0 \
    --comparison-operator GreaterThanThreshold \
    --dimensions Name=LoadBalancer,Value=app/wallet-service-alb/...
```

## Cost Estimation (Monthly)

### Development Environment
- RDS db.t3.small (Single-AZ): ~$30
- ECS Fargate (1 task, 0.5 vCPU, 1GB): ~$15
- ALB: ~$18
- Data Transfer: ~$10
- **Total: ~$73/month**

### Production Environment
- RDS db.r6g.xlarge (Multi-AZ): ~$600
- ECS Fargate (4 tasks, 1 vCPU, 2GB each): ~$250
- ALB: ~$18
- CloudWatch Logs: ~$5
- Data Transfer: ~$50
- Secrets Manager: ~$1
- **Total: ~$924/month**

## Security Best Practices

1. **Secrets Management**: Use AWS Secrets Manager for sensitive data
2. **Network Security**: 
   - Place ECS tasks in private subnets
   - Use NAT Gateway for outbound traffic
   - Restrict RDS security group to only ECS security group
3. **IAM Roles**: Use least-privilege IAM policies
4. **Encryption**: 
   - Enable RDS encryption at rest
   - Use SSL/TLS for database connections
   - Enable ALB SSL/TLS termination
5. **Monitoring**: Set up CloudWatch dashboards and alarms

## CI/CD Pipeline (GitHub Actions)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to AWS ECS

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      
      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v1
      
      - name: Build, tag, and push image to Amazon ECR
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          ECR_REPOSITORY: wallet-service
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          docker tag $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG $ECR_REGISTRY/$ECR_REPOSITORY:latest
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest
      
      - name: Update ECS service
        run: |
          aws ecs update-service \
            --cluster wallet-service-cluster \
            --service wallet-service \
            --force-new-deployment
```

## Testing the Deployment

```bash
# Get ALB DNS name
ALB_DNS=$(aws elbv2 describe-load-balancers \
    --names wallet-service-alb \
    --query 'LoadBalancers[0].DNSName' \
    --output text)

# Test health endpoint
curl http://$ALB_DNS/health

# Test API
curl -X POST http://$ALB_DNS/api/transactions/topup \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_001",
    "assetCode": "GOLD_COIN",
    "amount": 100,
    "idempotencyKey": "test-'$(date +%s)'"
  }'
```

## Monitoring and Troubleshooting

```bash
# View ECS service logs
aws logs tail /ecs/wallet-service --follow

# Check service status
aws ecs describe-services \
    --cluster wallet-service-cluster \
    --services wallet-service

# Check task status
aws ecs list-tasks \
    --cluster wallet-service-cluster \
    --service-name wallet-service

# Describe specific task
aws ecs describe-tasks \
    --cluster wallet-service-cluster \
    --tasks task-id
```

## Rollback Strategy

```bash
# List task definition revisions
aws ecs list-task-definitions \
    --family-prefix wallet-service

# Update service to previous revision
aws ecs update-service \
    --cluster wallet-service-cluster \
    --service wallet-service \
    --task-definition wallet-service:PREVIOUS_REVISION
```

## Production Checklist

- [ ] Enable RDS automated backups (7-35 days retention)
- [ ] Set up RDS read replicas for read scaling
- [ ] Configure CloudWatch dashboards
- [ ] Set up SNS topics for alerts
- [ ] Enable AWS WAF on ALB
- [ ] Configure Route 53 for custom domain
- [ ] Set up SSL certificate in ACM
- [ ] Enable VPC Flow Logs
- [ ] Configure AWS Config for compliance
- [ ] Set up AWS Backup for RDS
- [ ] Enable GuardDuty for threat detection
- [ ] Configure AWS Systems Manager Parameter Store
- [ ] Set up X-Ray for distributed tracing

---

**Live URL**: http://your-alb-dns-name.region.elb.amazonaws.com
