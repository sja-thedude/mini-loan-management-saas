# Interview Preparation: DataLendly, with Faraz (21 Oct 2026)

Role: Senior Full-Stack AWS Engineer / Technical Lead.

## 1. What I actually built and deployed (all verified 2026-10-20)

| Area | Status |
|---|---|
| Multi-tenant loan SaaS (Next.js, Express/TypeScript, Prisma, PostgreSQL) | ✅ Built, 48 automated tests |
| **Deployed on AWS (eu-north-1)** with Terraform: VPC, security groups, ECS Fargate (Graviton), ECR, Aurora Serverless v2 PostgreSQL, Lambda, SQS + DLQ, EventBridge, SNS, SES, DynamoDB, KMS, S3, Secrets Manager, SSM Parameter Store, CloudWatch (logs, metrics, alarms, dashboard, Logs Insights), X-Ray, CloudTrail, EventBridge Scheduler, Cognito user pool, CloudFront | ✅ ~86 resources, end-to-end checks passed |
| Tenant isolation: JWT scope + Postgres RLS + composite FKs + KMS encryption context | ✅ Verified on AWS (cross-tenant → 404) |
| Event-driven notifications: outbox → EventBridge → SQS → Lambda → SES/SNS/DynamoDB | ✅ Verified on AWS (real SES MessageId) |
| Financial integrity: BigInt cents, race-safe transitions, idempotency keys | ✅ Verified on AWS |
| Cost engineering: ≈ $2/month idle (Aurora scales to zero, Fargate on demand, nightly auto-stop, $5 budget, $20 hard limit) | ✅ |
| CI: GitHub Actions with Postgres + AWS-emulator service containers, Terraform validate, arm64 builds | ✅ Green |
| Cognito | Pool deployed; app still uses its own JWT auth (migration path documented) |
| GitHub → AWS deploy via OIDC | ❌ My account's SCP blocks OIDC providers. I deploy from my laptop with temporary credentials |

**Honest framing if asked about years of AWS experience:** *"Most of my professional infrastructure
has been Supabase, Cloudflare and Docker. To go deep on AWS I designed, deployed and operated this
project end to end, including debugging the issues real AWS surfaced that an emulator didn't."*
Then go straight into the specifics below. Depth beats claims.

## 2. Two-minute pitch

> "I built a multi-tenant loan management SaaS and deployed it on AWS with Terraform.
>
> **Compute:** the Next.js front end and the Express API run as two containers in one Fargate task
> on Graviton. A notification worker runs on Lambda.
>
> **Data:** Aurora Serverless v2 PostgreSQL in private subnets that **scales to zero** when idle. Row-level
> security enforces tenant isolation through a role that can't bypass it. I created that role with a one-off
> ECS task, so the app never holds master credentials.
>
> **Events:** every state change writes an outbox row in the same transaction. A publisher relays to
> EventBridge, then SQS with a DLQ, then Lambda, which sends SES emails, raises SNS alerts for large loans, and
> deduplicates on event id in DynamoDB with conditional writes and claim leases.
>
> **Security:** KMS encrypts PII with the tenant id as encryption context, so ciphertext can't be decrypted
> under another tenant. Secrets come from Secrets Manager and Parameter Store, and IAM roles are scoped per
> workload. CloudTrail runs with log file validation.
>
> **Operations:** a CloudWatch dashboard, alarms to SNS, X-Ray, Logs Insights queries and ECS Exec.
>
> **Cost:** it idles at about $2 a month: Aurora pauses, Fargate runs only on demand with a nightly
> auto-stop, there's a budget alert and a hard spend limit.
>
> Two things real AWS taught me that the emulator didn't. My account was single-Region, which I found by
> reading the SCP denies. And my worker role was missing `dynamodb:UpdateItem`, which exposed a retry bug that I
> fixed with claim leases."

## 3. Architecture decisions: what, why, alternative

| Decision | Why | Alternative and when |
|---|---|---|
| ECS Fargate for API + web | Long-lived Node keeps a DB pool; same Docker image locally; no servers | Lambda + API Gateway for spiky traffic (+ RDS Proxy); EKS at platform scale |
| Two containers, one task | Share `localhost`; one ENI/public IP; Next proxies `/api` | Separate services behind an ALB for independent scaling |
| Aurora Serverless v2, min 0 ACU | Postgres + RLS, pays ~nothing when idle; ~15 s resume (30 s connect timeout) | RDS db.t4g.micro (cheaper while busy, ~$12/month always-on); provisioned Aurora for steady load |
| Lambda worker on SQS | Scales to zero; partial batch failures; retries + DLQ | ECS worker for long jobs or steady high throughput |
| EventBridge in front of SQS | Content routing; add consumers without touching the API | SNS fan-out; Kinesis/MSK for ordered high volume |
| Transactional outbox | No dual-write gap between DB and bus | CDC (Debezium / logical replication) at scale |
| DynamoDB idempotency + lease | Conditional writes = atomic claim; lease recovers crashed invocations | Postgres table with `SELECT … FOR UPDATE SKIP LOCKED` |
| KMS encryption context | Cryptographic tenant binding; every decrypt in CloudTrail | Envelope encryption for > 4 KB payloads |
| SSM SecureString vs Secrets Manager | Free for static config/passwords; Secrets Manager where rotation matters | All in Secrets Manager (simpler, $0.40/secret) |
| Public subnet + public IP, no NAT | Saves ~$33/month NAT + ~$18 ALB | Production: ALB + ACM, private subnets, VPC endpoints |
| One shared Terraform module | Emulator (dev/CI) and AWS use the same definitions | Terragrunt/workspaces; CDK for TypeScript-first teams |

## 4. Questions Faraz may ask

### AWS fundamentals
1. **Execution role vs task role?** Execution role: ECS agent pulls the image, writes logs, injects secrets (mine
   reads one SSM parameter and the Aurora secret). Task role: the app's own calls (S3 under `tenants/*`, one KMS
   key, PutEvents on one bus, one secret, PutMetricData in one namespace).
2. **How does the container get the DB password?** The task definition's `secrets` points at an SSM SecureString.
   ECS fetches it at start with the execution role. The app builds the URL in memory. It's never in the image or repo.
3. **Why can't the internet reach your database?** Private subnets have no IGW route, `publicly_accessible=false`,
   and the DB SG only allows the app SG on 5432.
4. **How does Fargate pull from ECR without a NAT gateway?** The task has a public IP in a public subnet. In
   production I'd use private subnets plus VPC endpoints (ECR api/dkr, S3 gateway, Logs, Secrets Manager).
5. **What's an SCP? How did it affect you?** An Organizations guardrail capping what any principal can do. My
   account is a single-Region project: `us-east-1` calls failed with explicit denies, the same calls worked in
   `eu-north-1`, so I moved the stack there. Another SCP blocks OIDC providers.
6. **Aurora Serverless v2 scale-to-zero trade-offs?** ~15 s cold resume, so a longer connect timeout and an ECS
   health-check `startPeriod`. Fine for a demo or back office, not for latency-critical paths. Set `min_capacity` ≥ 0.5 there.

### Multi-tenancy and data integrity
7. **How is tenant A kept from B's data?** Tenant from the JWT only. RLS with `FORCE` through a
   `NOSUPERUSER NOBYPASSRLS` role (verified on Aurora). Composite FKs. KMS context. S3 key prefixes. Tested.
8. **Why `set_config(…, true)`?** Transaction-local, so it can't leak across pooled connections and it's PgBouncer-safe.
9. **Double approval?** Conditional `UPDATE … WHERE status='PENDING'`: one wins, the other gets 409.
10. **Retried payment?** Idempotency-Key inserted first (tenant+key PK). Retry replays the response, a concurrent
    duplicate gets 409, and a different body gets 422.
11. **Money?** BigInt cents, string transport, round-half-up, last installment absorbs drift. DB CHECK constraints.

### Event-driven
12. **At-least-once: how do you avoid duplicate emails?** DynamoDB conditional claim per `eventId`. DONE means
    acknowledge and skip. A fresh PROCESSING claim means fail the record so SQS retries after the lease. A stale
    claim older than 2 minutes gets taken over.
13. **What bug did you find in production?** The worker role lacked `dynamodb:UpdateItem`. The emulator doesn't
    enforce IAM, so the tests passed. On AWS the status update failed, retries treated the event as a
    duplicate, and records stuck at PROCESSING. I fixed IAM, added the lease logic, added a test, and redeployed.
14. **ReportBatchItemFailures?** Return only the failed message IDs. Others aren't retried. After
    maxReceiveCount the failed one goes to the DLQ, which has an alarm.
15. **Visibility timeout vs Lambda timeout?** Visibility (60 s) must exceed the Lambda timeout (30 s), or messages are redelivered mid-flight.

### Operations, cost, leadership
16. **How do you monitor it?** Operations dashboard (business metric, Lambda, SQS age/DLQ, ECS, Aurora ACU, API 5xx
    table). Alarms → SNS. Log metric filter for API 5xx. Saved Logs Insights queries. X-Ray on the worker. CloudTrail.
17. **How do you debug a running container?** ECS Exec (SSM Session Manager, audited, no SSH).
18. **How do you keep cost under $5?** Aurora pause, on-demand Fargate plus a nightly Scheduler stop, Graviton,
    PAY_PER_REQUEST DynamoDB, 7-day log retention, ECR lifecycle, S3 Bucket Keys, SSM over Secrets Manager
    where rotation isn't needed, no NAT/ALB. Guarded by a budget and a hard spend limit.
19. **Zero-downtime deploys?** ECS rolling deploy with circuit-breaker rollback. Expand/contract migrations run as a
    one-off task before the service update.
20. **Rolling this out to a team?**
    - Multi-account (dev/stage/prod) with SCP guardrails.
    - Shared Terraform modules and CI with emulator tests.
    - OIDC deploy roles.
    - ADRs, plus runbooks (DLQ redrive, Aurora resume).

### Questions to ask Faraz
- How is DataLendly's AWS organized (accounts, SCPs, landing zone)?
- ECS vs Lambda today, and what's driving changes?
- How do you handle tenant isolation and data residency for lender clients?
- What does on-call look like for payment-affecting incidents?

## 5. Demo script (5 minutes)

1. `scripts/app.sh start`, then open the printed URL → "Acme · Admin". Dashboard → approve a pending loan → schedule.
2. Log in as Bluebird → Acme's data is invisible.
3. Create a customer with a national ID → masked → **Reveal** (KMS decrypt, audited).
4. Approve a $60,000+ loan → AWS console:
   - **DynamoDB** item `DONE`;
   - **Lambda** logs;
   - **X-Ray** trace;
   - **SNS** alert.
5. **CloudWatch dashboard** `loan-app-operations`, then **CloudTrail** event history.
6. Show `infra/` (modules shared with `infra/local`), then `scripts/app.sh stop`.

Always-on static demo: https://da2lxef9ohfff.cloudfront.net (S3 + CloudFront).
