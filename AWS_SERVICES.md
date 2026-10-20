# AWS Services Inventory

Every AWS service in this project: where it runs, how it was verified, and what it costs.
Last verified: **2026-10-20**, region **eu-north-1 (Stockholm)**.

## Account facts

| Fact | How verified |
|---|---|
| New-style AWS "project" account, upgraded to the **paid plan** with a **$20/month hard spend limit** and 3 early cost controls (stop new launches, pause idle, pause top cost drivers) | Billing console |
| $120 credits pay for usage first | Billing console / `aws freetier get-account-plan-state` |
| **Single-Region account:** only `eu-north-1` is enabled. Other Regions are denied by an Organizations SCP | Explicit-deny errors in `us-east-1`; same calls succeed in `eu-north-1` (CloudShell + CLI) |
| External identity providers (IAM OIDC) are denied by a second SCP | `iam:CreateOpenIDConnectProvider` → explicit deny |
| AWS Budget: $5/month, alerts at 50/80/100% actual + 100% forecast | Terraform `infra/budget.tf` |

## Deployed on AWS and verified ✅

| Service | What it does here | Verified by |
|---|---|---|
| **VPC** | 10.0.0.0/16, 2 public + 2 private subnets in 2 AZs, IGW, route tables; **no NAT** (cost) | Terraform apply; app reachable; DB unreachable from the internet |
| **Security groups** | App SG: port 3001 from one /32 only. DB SG: 5432 only from the app SG | Requests from the allowed IP work |
| **ECS Fargate (ARM64/Graviton)** | One task, two containers (Next.js + API) sharing `localhost`; circuit breaker with rollback; **ECS Exec** enabled | `scripts/app.sh start` → healthy; Exec agent RUNNING |
| **ECR** | Private repos for api/web images, scan on push, lifecycle (keep 5) | Images pushed from laptop (arm64) |
| **Aurora Serverless v2 PostgreSQL 16.9** | **Scales to 0 ACU** after 5 idle minutes; private subnets, encrypted, RDS-managed master secret | One-off bootstrap task created `loan_app` with `rolsuper=false, rolbypassrls=false`; migrations applied; demo data seeded |
| **ECS one-off tasks** | DB role bootstrap (only task with master creds) and seeding | Exit code 0, logs in CloudWatch |
| **KMS** (customer-managed key, rotation on) | Field-level PII encryption with a tenant encryption context; SSE-KMS for S3, SNS, DynamoDB, Secrets Manager | National ID stored as ciphertext, masked in API; admin reveal decrypts; S3 object `ServerSideEncryption=aws:kms` |
| **S3** | Loan documents: presigned POST (size/type enforced) + presigned GET, tenant-prefixed keys, Block Public Access | Upload 204 and download via presigned URLs from the live app |
| **EventBridge** | Custom bus + rule routing `loan-app.api` events to SQS | Approval in the live app → event delivered |
| **SQS** | Event queue + DLQ (maxReceiveCount 5), queue policy scoped to the rule; ops-alert inbox | Messages consumed; DLQ depth 0 |
| **Lambda** (Node 22, ARM64) | Notification worker on an SQS event-source mapping, partial batch failures, max concurrency 2, **X-Ray tracing** | Records reach `DONE`; X-Ray trace recorded |
| **DynamoDB** | Idempotent notification log (tenant partition, conditional claim + lease), TTL, PITR, SSE-KMS | Items with status `DONE` and SES message IDs |
| **SES** | Approval/rejection emails from a verified sender (sandbox → AWS mailbox simulator) | Real SES MessageId in DynamoDB |
| **SNS** | Ops alerts for loans ≥ $50,000 (KMS-encrypted topic) → SQS subscription; CloudWatch alarm actions | Alert message received for a $75,000 approval |
| **Secrets Manager** | JWT signing key (loaded at API start); Aurora master password (RDS-managed) | API issues sessions; bootstrap task reads the master secret |
| **SSM Parameter Store** | App DB password (SecureString, injected by ECS), high-value threshold, SES sender | Containers start; threshold drives the SNS alert |
| **IAM** | Execution role, API task role, worker role, scheduler role; least-privilege, resource-scoped | Real AWS caught a missing `dynamodb:UpdateItem` → fixed; Access Analyzer: 0 findings |
| **CloudWatch Logs** | ECS (`/ecs/loan-app`) and Lambda (`/loan-app/prod/worker`, JSON format), 7-day retention | Logs tailed during verification |
| **CloudWatch Metrics/Alarms/Dashboards** | `LoanApp/LoanDecisions`, log metric filter `Api5xx`; alarms: worker errors, queue age, API 5xx, DLQ not empty → SNS; operations dashboard; 3 saved Logs Insights queries | Metric present; alarms + dashboard created |
| **AWS X-Ray** | Active tracing on the worker Lambda | Trace summary returned |
| **EventBridge Scheduler** | Nightly `ecs:UpdateService desiredCount=0` (cost guardrail) | Schedule created |
| **CloudTrail** | Trail to an encrypted S3 bucket with **log file integrity validation**, 90-day lifecycle | `IsLogging: true` |
| **Cognito** | User pool (immutable `custom:tenant_id`, optional TOTP MFA, password policy), web client, ADMIN/OFFICER groups | Pool created. **Not yet wired into the app's login** |
| **CloudFront + S3 (static site)** | Always-on demo: private bucket with **Origin Access Control**, CloudFront Function URL rewrites, security-headers policy, HTTPS redirect | All routes 200, direct S3 access 403, HTTP → HTTPS 301 |
| **AWS Budgets** | $5 budget with email alerts | In place |
| **IAM Access Analyzer** | `scripts/validate-iam-policies.sh` | 0 findings |

## Not deployed, and why

| Service | Reason |
|---|---|
| GitHub Actions → AWS via OIDC | Account SCP denies creating OIDC identity providers. Terraform kept behind `enable_github_oidc` |
| ALB + ACM + Route 53 | ~$18/month (ALB) + $0.50/zone; the budget is $5. CloudFront serves HTTPS for the static site |
| NAT Gateway / VPC endpoints | ~$33/month / ~$7 per endpoint. Fargate uses a public IP instead |
| WAF, GuardDuty, AWS Config, Security Hub | Ongoing charges beyond the $5 budget |
| Multi-Region / DR | Account is single-Region |

## Costs (estimates from list prices; check Billing for actuals)

| Item | Cost |
|---|---|
| Always on: KMS key $1, 2 Secrets Manager secrets $0.80, Aurora storage < 1 GB ~$0.10, ECR ~0.3 GB ~$0.03 | **≈ $2/month** |
| While the app runs: Aurora ~0.5 ACU, Fargate 0.5 vCPU/1 GB ARM, public IPv4 | **≈ $0.09/hour** |
| Lambda, SQS, SNS, EventBridge, DynamoDB, SES, CloudWatch (within free allowances), X-Ray, CloudTrail (first trail), CloudFront | ≈ $0 |

Guardrails: $20 hard spend limit, $5 budget alerts, nightly auto-stop, Aurora auto-pause, `scripts/app.sh stop`.

## Local equivalents (development and CI)

- moto (Apache-2.0 AWS emulator) on `:4566`, provisioned by `infra/local` with the **same** Terraform module.
- PostgreSQL 16 in Docker. 48 automated tests, including 15 against the emulator.
- Public mirror of the static demo on Cloudflare Pages: https://mini-loan-saas-demo.pages.dev
