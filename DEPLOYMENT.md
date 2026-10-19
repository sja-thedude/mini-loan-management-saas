# Deployment

Three targets. Only the first two are live; the third is documented and validated.

## 1. Public demo: Cloudflare Pages ($0) ✅ live

URL: **https://mini-loan-saas-demo.pages.dev** (Cloudflare account "SJA Account", project `mini-loan-saas-demo`).

It is the same Next.js UI built as a static export (`NEXT_PUBLIC_DEMO_MODE=true`). API calls go to an
in-browser mock (`apps/web/src/lib/demo/`) that applies the same validation, roles and tenant rule
to fictional seed data kept in the browser's localStorage. Security headers come from
`apps/web/public/_headers`.

```bash
npm run build:demo
CLOUDFLARE_ACCOUNT_ID=<id> npx wrangler@4 pages deploy apps/web/out --project-name mini-loan-saas-demo --branch main
```

CI/CD: `.github/workflows/deploy-demo.yml` deploys after CI passes on `main`. It needs the repo secrets
`CLOUDFLARE_API_TOKEN` (Pages:Edit) and `CLOUDFLARE_ACCOUNT_ID`.

Verified 2026-10-19: all routes return 200, unknown paths 404, HSTS/CSP/X-Frame-Options/nosniff present,
`/_next/static/*` immutable.

## 2. Full stack locally with the AWS emulator ($0) ✅ running

```bash
npm install
docker compose up -d --wait          # Postgres :5433 + AWS emulator (moto) :4566
npm run aws:bootstrap                # resets the emulator, terraform apply infra/local (28 resources)
cp .env.example apps/api/.env        # already contains the emulator settings
cp apps/worker/.env.example apps/worker/.env
npm run db:migrate && npm run db:seed
npm run dev                          # api :4000, web :3001, worker (SQS poller)
npm test                             # 47 tests (API + AWS integration, worker, demo)
```

Inspect the emulated AWS:
```bash
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
aws logs filter-log-events --log-group-name /loan-app/local/worker
aws dynamodb scan --table-name loan-app-local-notifications
aws sqs get-queue-attributes --queue-url http://localhost:4566/123456789012/loan-app-local-loan-events-dlq --attribute-names All
```

The emulator is in-memory. After `docker compose restart aws`, run `npm run aws:bootstrap` again.

## 3. AWS production design (`infra/`): validated, ❌ not deployable on this account

The Free-plan account's SCP denies VPC, ECS, ECR, RDS, Lambda, S3 bucket creation and more
(see [AWS_SERVICES.md](AWS_SERVICES.md)). To deploy, the account must be upgraded to the Paid plan
(credits remain; the card becomes chargeable beyond them). **Ask before doing this.**

Estimated cost if deployed: about $35/month or $1.20/day:
- RDS db.t4g.micro ~$12
- Fargate 0.5 vCPU / 1 GB ARM ~$14
- public IPv4 ~$3.60
- Secrets Manager ~$1.20
- KMS key $1
- Lambda / SQS / SNS / EventBridge / DynamoDB / CloudWatch at demo volumes: within the always-free tier

Runbook, after the upgrade and with `aws login --profile loan`:
```bash
cd infra && cp terraform.tfvars.example terraform.tfvars   # alert_email, allowed_cidr, region
npm run build -w apps/worker                               # Lambda bundle
terraform init && terraform plan -var desired_count=0 -out=tfplan   # REVIEW, then approve
terraform apply tfplan
# push images to ECR (linux/arm64)
REGISTRY=$(terraform output -raw ecr_registry)
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/arm64 -f ../apps/api/Dockerfile -t "$REGISTRY/loan-app-api:latest" .. && docker push "$REGISTRY/loan-app-api:latest"
docker build --platform linux/arm64 -f ../apps/web/Dockerfile -t "$REGISTRY/loan-app-web:latest" .. && docker push "$REGISTRY/loan-app-web:latest"
# one-off: create the least-privilege DB role
NET="awsvpcConfiguration={subnets=[$(terraform output -raw public_subnets)],securityGroups=[$(terraform output -raw app_security_group)],assignPublicIp=ENABLED}"
aws ecs run-task --cluster loan-app --launch-type FARGATE --task-definition loan-app-db-bootstrap --network-configuration "$NET"
terraform apply -var desired_count=1
# teardown
terraform destroy
```

Note: SES starts in **sandbox** mode (verified recipients only) until you request production access.

## Real AWS resources currently in the account

| Resource | Cost |
|---|---|
| AWS Budget `loan-app-monthly` ($10, email alerts) | $0 |

Nothing else. The CloudFront config objects created during exploration were destroyed.
