# Deployment

| Target | URL | Status |
|---|---|---|
| **AWS: full stack** (ECS Fargate + Aurora + Lambda…) | `scripts/app.sh url` (public IP changes each start; only the allowed IP can connect) | ✅ Deployed 2026-10-20, eu-north-1 |
| **AWS: static demo** (S3 + CloudFront) | https://da2lxef9ohfff.cloudfront.net | ✅ Live |
| Cloudflare Pages mirror | https://mini-loan-saas-demo.pages.dev | ✅ Live |
| Local full stack + AWS emulator | http://localhost:3001 | ✅ |

## Day-to-day on AWS

```bash
aws login --profile loan            # temporary credentials (browser sign-in)
export AWS_PROFILE=loan             # region eu-north-1 is set in ~/.aws/config
scripts/app.sh start                # Fargate on; Aurora resumes from zero on first connection; prints URL
scripts/app.sh logs                 # tail ECS logs
scripts/app.sh stop                 # Fargate off; Aurora pauses after 5 idle minutes
```
A nightly EventBridge Scheduler job also stops the app at 20:00 UTC.

Demo sign-in: company `acme` or `bluebird`, `admin@<company>.example`, password `DemoPassword123!`.

Shell into a running container (ECS Exec, through SSM Session Manager; works in AWS CloudShell):
```bash
TASK=$(aws ecs list-tasks --cluster loan-app --service-name loan-app --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster loan-app --task "$TASK" --container api --interactive --command "/bin/sh"
```

## How it was deployed (reproducible runbook)

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars      # alert_email, allowed_cidr (your IP/32), notification_sender
npm run build -w apps/worker                      # Lambda bundle (apps/worker/dist)
terraform init
terraform plan -out=tfplan                        # review: ~86 resources, app desired_count = 0
terraform apply tfplan                            # Aurora takes ~10 min
# SES: click the verification link sent to notification_sender

# Images (linux/arm64 for Graviton)
R=$(terraform output -raw ecr_registry)
aws ecr get-login-password | docker login --username AWS --password-stdin "$R"
docker build --platform linux/arm64 -f ../apps/api/Dockerfile -t "$R/loan-app-api:latest" .. && docker push "$R/loan-app-api:latest"
docker build --platform linux/arm64 -f ../apps/web/Dockerfile -t "$R/loan-app-web:latest" .. && docker push "$R/loan-app-web:latest"

# One-off: least-privilege DB role (the only task that receives master credentials)
NET="awsvpcConfiguration={subnets=[$(terraform output -raw public_subnets)],securityGroups=[$(terraform output -raw app_security_group)],assignPublicIp=ENABLED}"
aws ecs run-task --cluster loan-app --launch-type FARGATE --task-definition loan-app-db-bootstrap --network-configuration "$NET"

../scripts/app.sh start                           # API runs `prisma migrate deploy` on start

# One-off: seed fictional demo data
aws ecs run-task --cluster loan-app --launch-type FARGATE --task-definition loan-app-db-bootstrap \
  --network-configuration "$NET" --overrides '{"containerOverrides":[{"name":"bootstrap","command":["node","dist/prisma/seed.js"]}]}'

# Static site (separate state)
cd static-site && terraform apply
aws s3 sync ../../apps/web/out s3://$(terraform output -raw bucket) --delete
aws cloudfront create-invalidation --distribution-id $(terraform output -raw distribution_id) --paths "/*"
```

## Verification performed on AWS (2026-10-20)

| Check | Result |
|---|---|
| `GET /api/health` (also checks Aurora connectivity) | `{"status":"ok"}` |
| Login (both tenants) | 200 |
| Acme reads / approves a Bluebird loan | **404 / 404** |
| Create customer with national ID | Stored KMS ciphertext; API returns `***-**-3456` |
| Admin reveals national ID | Decrypted via KMS with tenant context |
| Retried loan creation with the same Idempotency-Key | Same loan id (no duplicate) |
| Document upload (presigned POST) / download (presigned GET) | 204 / content matches; object `aws:kms` encrypted |
| Approval → EventBridge → SQS → Lambda | DynamoDB `DONE`, real SES MessageId |
| $75,000 approval | SNS ops alert delivered |
| DLQ depth | 0 |
| X-Ray | Trace recorded for the worker |
| CloudTrail | `IsLogging: true` |
| DB role on Aurora | `rolsuper=false, rolbypassrls=false` |
| Static site | Routes 200, unknown 404, S3 direct 403, HTTP → HTTPS 301, security headers present |

**Issue found only on real AWS:** the worker role lacked `dynamodb:UpdateItem` (the emulator doesn't
enforce IAM), and the resulting retries were acknowledged as duplicates. I fixed the policy and added
claim leases (a stale `PROCESSING` claim can be taken over; a fresh one is retried, not acknowledged).

## Teardown (after the interview)

```bash
scripts/app.sh stop
cd infra/static-site && terraform destroy
cd .. && terraform destroy          # removes everything incl. Aurora, KMS key (7-day deletion window)
```
