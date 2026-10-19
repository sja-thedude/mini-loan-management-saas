# AWS Services Inventory

What was **actually used**, how, and at what cost. Every claim here was checked on
2026-10-19. "Tested" means an automated test or a command whose output was verified.

## Constraints discovered

| Fact | How verified |
|---|---|
| My account is on the AWS **Free plan**, ACTIVE, **$100 credits**, expires 2027-04-19 | `aws freetier get-account-plan-state` |
| The Free plan **cannot charge the card**: usage draws down credits; when they run out the account is paused, not billed | AWS Free plan terms (third-party summaries agree); plan type from the API above |
| The account sits in an AWS-managed Organization (`o-bek9fg6c12`) whose **SCPs explicitly deny** most services | `aws organizations describe-organization` + explicit-deny errors naming the SCP ARNs |
| Allowed: IAM roles, CloudWatch Logs groups, CloudFront config objects, read-only S3/CloudFront/Route 53/ACM/WAF listing, Budgets, CloudTrail event history, IAM Access Analyzer | Create/list probes (cleaned up afterwards) |
| Denied: S3 `CreateBucket`, EC2/VPC, ECS, ECR, RDS, Lambda, API Gateway, DynamoDB, SQS, SNS, KMS, SSM, Secrets Manager, Cognito, CloudFormation, App Runner, Amplify, Aurora DSQL, CloudWatch alarms/dashboards/metrics, IAM OIDC providers | Same probes |
| LocalStack's free community image was retired on 2026-03-23; newer images need an account token | LocalStack/GitHub announcements. **moto** (Apache-2.0, no account) used instead |

## Tier 1: Real AWS ($0, used and verified)

| Service | What we did | Cost |
|---|---|---|
| **AWS Budgets** | $10/month cost budget; email alerts at 50/80/100% actual and 100% forecast (Terraform: `infra/budget.tf`) | Free (budgets have no charge; action-enabled budgets beyond 2 do) |
| **IAM / STS** | `aws login` → temporary role credentials (no access keys on disk); `sts get-caller-identity` | Free |
| **IAM Access Analyzer** | `scripts/validate-iam-policies.sh` validates the API and worker policies: **0 findings**. An intentionally bad policy is flagged `PASS_ROLE_WITH_STAR_IN_RESOURCE` | Free (policy validation) |
| **AWS CloudTrail (Event history)** | `aws cloudtrail lookup-events` shows our own management events (e.g. CloudFront deletes) | Free (90-day management-event history) |
| **AWS Organizations (read) / SCPs** | Diagnosed the guardrail blocking deployment from explicit-deny errors | Free |
| **Free Tier API** | Read plan type, credits and expiry | Free |
| **CloudFront** | Created then destroyed a CloudFront Function, Origin Access Control and response-headers policy. A distribution was not possible because the SCP blocks the S3 origin bucket | Free (config objects) |

Nothing billable exists in the account. Only the budget remains.

## Tier 2: Emulated locally (moto in Docker) and covered by automated tests

Provisioned by `infra/local` → `infra/modules/app-services`, the **same Terraform module** the
production design uses. Tested by `apps/api/test/aws.test.ts` (9 tests) and
`apps/worker/test/handler.test.ts` (5 tests), plus a live end-to-end run.

| Service | How the app uses it | Verified by |
|---|---|---|
| **S3** | Loan documents: presigned **POST** (size + content-type enforced), presigned GET (60 s), tenant-prefixed keys, Block Public Access, CORS, lifecycle | Upload via presigned POST then download; cross-tenant download → 404 |
| **KMS** | Customer-managed key with rotation; **field-level encryption** of national IDs with an encryption context of `{tenantId, field}`; SSE-KMS on S3, SNS, DynamoDB, Secrets Manager | Ciphertext stored, plaintext never stored; **decrypt with another tenant's context fails** (`InvalidCiphertextException`); S3 object shows `aws:kms` |
| **EventBridge** | Custom bus `loan-app-<env>-events`; rule on `source=loan-app.api` with five detail-types; SQS target | E2E: approval → event on the queue |
| **SQS** | Event queue with **DLQ redrive** (maxReceiveCount 5), long polling, SSE, queue policy scoped to the rule ARN | Partial-batch failure then retry. The DLQ move itself is configured but **not** exercised by a test |
| **SNS** | Ops-alert topic for loans ≥ threshold, with a raw-delivery SQS subscription | Alert received on the subscribed queue |
| **SES** | Approval/rejection emails from a verified sender | Send count increases; an unverified sender is rejected → retry path |
| **DynamoDB** | Idempotent notification log (`tenantId` + `eventId`), conditional writes, TTL, PITR, SSE-KMS | Redelivered event → no second email |
| **SSM Parameter Store** | Non-secret config (high-value threshold, sender) read at startup / Lambda cold start | Threshold from SSM drives the SNS alert |
| **Secrets Manager** | JWT signing key loaded at API startup (`JWT_SECRET_ID`) | Live run: API logs in with the key from Secrets Manager |
| **CloudWatch Logs** | Worker ships JSON logs to `/loan-app/local/worker` | Live run: 5 events in the log group |
| **CloudWatch Metrics** | `LoanApp/LoanDecisions{Decision}` via PutMetricData (fire-and-forget) | Live run: datapoint present |
| **IAM** | Least-privilege roles and policies for the API and worker (the emulator doesn't enforce them, but they're validated on real AWS by Access Analyzer) | Access Analyzer: 0 findings |
| **Lambda (handler code)** | `apps/worker/src/handler.ts` is a real `SQSEvent → SQSBatchResponse` handler; a local runner mimics the event-source mapping | Handler unit/integration tests. **The real Lambda runtime was not executed** |

Local stand-ins: **PostgreSQL 16 in Docker** for RDS; **Docker images** (linux/arm64) built and
run as a simulated ECS task (two containers sharing `localhost`).

## Tier 3: Infrastructure as code only (`terraform validate` passes, never applied)

| Service | Where | Why not deployed |
|---|---|---|
| VPC, subnets, IGW, route tables, security groups | `infra/network.tf` | SCP denies EC2/VPC |
| RDS PostgreSQL (private, encrypted, managed master secret) | `infra/database.tf` | SCP denies RDS |
| ECS Fargate (cluster, task defs, service, circuit breaker), ECR | `infra/ecs.tf` | SCP denies ECS/ECR |
| Lambda function + SQS event-source mapping + DLQ alarm | `infra/lambda.tf` | SCP denies Lambda |
| Cognito user pool (immutable `custom:tenant_id`, MFA, groups) | `infra/cognito.tf` | SCP denies Cognito; also not wired into the app |
| S3 + CloudFront (OAC, function, headers) + GitHub OIDC + dashboard/alarms | `infra/static-site/` | SCP denies S3 buckets and OIDC providers |

## Not used, and why

| Service | Reason |
|---|---|
| API Gateway | The API runs as a container behind Next.js. API Gateway would front Lambda-based APIs, which this design doesn't need. Blocked by the SCP anyway |
| EC2 | Fargate chosen (no servers to patch). Blocked |
| Route 53 / ACM | A hosted zone costs $0.50/month; ACM needs an owned domain |
| WAF | $5/month per web ACL + $1/rule |
| Cost Explorer API | $0.01 per request; also "not enabled" on this account |
| CloudFormation | Terraform chosen; blocked by the SCP |
| Step Functions, App Runner, Amplify | Not needed / blocked |

## Where the app is hosted

| Environment | Where | Cost |
|---|---|---|
| Public demo | **Cloudflare Pages**: https://mini-loan-saas-demo.pages.dev (static export + in-browser mock API) | $0 (Pages free plan) |
| Full stack | Your laptop: Docker (Postgres + moto) + API + web + worker | $0 |
| Production design | AWS (Terraform in `infra/`) | ~$35/month if deployed; not deployed |
