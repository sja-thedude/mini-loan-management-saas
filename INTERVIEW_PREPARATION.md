# Interview Preparation: DataLendly, with Faraz (21 Oct 2026)

Role: Senior Full-Stack AWS Engineer / Technical Lead.

## 1. What I actually did (say exactly this, no more)

| Area | Status | Evidence |
|---|---|---|
| Multi-tenant loan app (Next.js, Express/TS, Prisma, Postgres) | ✅ Built, running | 47 automated tests pass |
| Tenant isolation: JWT scope + Postgres RLS + composite FKs | ✅ Tested | "Unfiltered query still returns only own tenant", "no tenant set → 0 rows" |
| Exact money math (BigInt cents, amortization) | ✅ Tested | Textbook 10k @ 12% / 12 → 888.49; schedules sum exactly |
| Idempotency keys on loan creation + payments | ✅ Tested | Retry → same loan; retried payment recorded once |
| Transactional outbox → EventBridge → SQS → Lambda-style worker → SES/SNS/DynamoDB | ✅ Tested **on a local AWS emulator** | E2E test + live run |
| KMS field-level encryption with tenant encryption context | ✅ Tested **on the emulator** | Wrong-tenant decrypt → `InvalidCiphertextException` |
| S3 presigned POST/GET with SSE-KMS | ✅ Tested **on the emulator** | Upload/download test |
| Secrets Manager / SSM config, CloudWatch Logs + metrics | ✅ Verified **on the emulator** | Live run |
| Terraform: one shared module for local + production | ✅ Applied to the emulator; production root **validated, not applied** | `terraform validate` in CI |
| Real AWS: Budgets, Access Analyzer, CloudTrail, temporary-credential CLI login | ✅ Done on my real account at $0 | 0 Access Analyzer findings |
| Real AWS deployment of ECS/RDS/Lambda | ❌ **Not done.** My Free-plan account's SCP blocks those services | Explicit-deny errors |
| Public demo | ✅ Cloudflare Pages: https://mini-loan-saas-demo.pages.dev | Live |
| CI/CD | ✅ CI green on GitHub: Postgres + AWS emulator services, Terraform fmt/validate, 47 tests, arm64 image builds. Pages auto-deploy workflow ready (needs `CLOUDFLARE_API_TOKEN`) | [CI run](https://github.com/sja-thedude/mini-loan-management-saas/actions/runs/39245653401) |

**If Faraz asks "have you deployed ECS/RDS in production?"** Answer: *"Not in a job yet, and I want
to be precise about that. I built this project to close the gap. I designed and validated the
Terraform for ECS, RDS and Lambda. My sandbox account's Organizations SCP blocked deploying them,
so I ran the AWS-facing code against a local AWS emulator with integration tests, and used the
real account for what it allowed: budgets, IAM Access Analyzer and CloudTrail."*

## 2. Two-minute pitch

> "I built a multi-tenant loan management SaaS to deepen my AWS skills: companies manage
> customers, take applications, approve them, and track amortized repayments.
>
> Three things I treated as non-negotiable for lending:
>
> **Isolation.** The tenant comes only from the verified token. Postgres row-level security uses a
> transaction-local tenant setting through a role that can't bypass RLS. Composite foreign keys stop
> cross-tenant references. KMS encryption context binds encrypted PII to its tenant. There are tests
> for each layer.
>
> **Financial integrity.** Integer cents with BigInt amortization, conditional state transitions
> so a loan can't be approved twice, and Stripe-style idempotency keys so a retried payment is
> recorded once.
>
> **Reliable side effects.** Every state change writes an outbox row in the same transaction. A
> publisher relays to EventBridge. A rule routes to SQS with a DLQ. A Lambda-style worker sends
> SES email and SNS ops alerts, deduplicating on event id with a DynamoDB conditional write, and
> reports partial batch failures.
>
> Infrastructure is Terraform with one shared module that I apply to a local AWS emulator in dev and
> CI and that the production root reuses with ECS Fargate, RDS, Lambda and Cognito. When my account's
> SCP blocked deployment, I diagnosed it from the explicit-deny errors. That's the same guardrail
> mechanism DataLendly would use across its accounts."

## 3. Architecture decisions: what, why, alternative

| Decision | Why | Alternative and when I'd pick it |
|---|---|---|
| ECS Fargate for the API | Long-lived Node process keeps a DB pool; same Docker image locally | Lambda + API Gateway for spiky traffic (needs RDS Proxy); EKS only at platform scale |
| Lambda for the worker | Event-driven, scales to zero, SQS mapping gives retries + partial failures | ECS worker service for long jobs (>15 min) or steady high throughput |
| EventBridge → SQS (not straight to Lambda) | SQS buffers, retries and parks poison messages in a DLQ; rules enable fan-out | SNS → SQS fan-out; Kinesis/MSK for ordered high-volume streams |
| Transactional outbox | Avoids dual-write bugs (DB commit OK, publish failed, or the reverse) | Postgres logical replication / Debezium CDC at scale |
| DynamoDB for the notification log | Conditional writes = cheap idempotency; TTL; tenant partition key | A Postgres table (fine too). I used DynamoDB to show the pattern |
| RDS PostgreSQL | Relational integrity, RLS, transactions for money | Aurora Serverless v2 for variable load; DynamoDB isn't a fit for a loan ledger |
| KMS encryption context | Cryptographic tenant binding + CloudTrail audit of every decrypt | Envelope encryption (GenerateDataKey) for payloads > 4 KB |
| Secrets Manager (secrets) vs SSM (config) | Rotation + audit for secrets; free Standard parameters for config | SSM SecureString for secrets when rotation isn't needed |
| Presigned POST, not PUT | S3 enforces size range + content type | Upload through the API (simpler, but the API pays for bandwidth and memory) |
| Shared Terraform module | Dev, CI and prod are provisioned from the same code | Terragrunt / workspaces per env; CDK if the team prefers TypeScript |
| No NAT / ALB in the learning design | Saves ~$50/month | Production: ALB + ACM, private subnets + VPC endpoints |

## 4. Questions Faraz may ask, with answers

### Multi-tenancy
1. **How do you guarantee tenant A never sees tenant B's data?** Four layers: tenant from JWT only;
   RLS with FORCE through a NOBYPASSRLS role (fails closed); composite FKs; KMS context + S3 prefixes.
   Tested, including an unfiltered query.
2. **Why `set_config(…, true)` and not `SET`?** It's transaction-local, so it can't leak to the next
   request on a pooled connection. It's also safe with PgBouncer in transaction mode.
3. **Shared schema vs schema-per-tenant vs DB-per-tenant?** Shared is the cheapest and simplest to
   migrate. DB-per-tenant is for regulated or large tenants that need separate backups, keys or data residency.
4. **Why 404 instead of 403 for other tenants' records?** So the API never confirms the record exists.

### Financial integrity
5. **Why not floats?** 0.1 + 0.2 ≠ 0.3. I use BigInt cents, string transport (JSON loses precision
   above 2^53), and explicit round-half-up. The last installment absorbs drift.
6. **Two admins approve at once?** Conditional `UPDATE … WHERE status='PENDING'`. Exactly one gets
   rows=1; the other gets 409.
7. **Client times out and retries a payment?** The Idempotency-Key is inserted first (PK
   tenant+key). A retry replays the stored response. A concurrent duplicate gets 409. A different body gets 422.
8. **How do you avoid "loan approved but the email event was lost"?** Transactional outbox: the event row
   commits with the approval. The publisher uses `FOR UPDATE SKIP LOCKED` so several API tasks can publish safely.

### Event-driven / AWS
9. **At-least-once delivery: how do you prevent duplicate emails?** A DynamoDB conditional put on
   `eventId` claims the event first. A duplicate fails the condition and is acknowledged with no side effects.
   A FAILED status can be re-claimed.
10. **What is `ReportBatchItemFailures`?** Lambda returns only the failed message IDs, so successful
    messages in the batch aren't retried. After maxReceiveCount the failed one moves to the DLQ, and an alarm fires.
11. **Why must the visibility timeout exceed the Lambda timeout?** Otherwise SQS redelivers a message while
    it's still being processed.
12. **EventBridge vs SNS vs SQS?** EventBridge: content-based routing, many targets, schema/archive.
    SNS: fan-out pub/sub. SQS: a durable buffer with retries for one consumer group.
13. **Lambda vs Fargate for the API?** Fargate: steady traffic, connection pools, no cold starts.
    Lambda: bursty or event work; for APIs on RDS add RDS Proxy.

### Security
14. **Execution role vs task role?** Execution: ECS agent (pull image, logs, inject secrets).
    Task: the app's own AWS calls.
15. **How do containers get secrets?** The ECS `secrets` field injects the DB password from Secrets
    Manager at start. The app fetches the JWT key with its task role. Nothing is in the image or repo.
16. **What does KMS encryption context add?** It's authenticated data. A ciphertext moved to another
    tenant's row can't be decrypted, and the context appears in CloudTrail for every Decrypt.
17. **How do you check IAM least privilege?** IAM Access Analyzer `ValidatePolicy` in a script
    (0 findings). Resource-scoped ARNs. Condition keys where there are no resource ARNs
    (`cloudwatch:namespace`, `ses:FromAddress`).
18. **What's an SCP and how did it affect you?** An Organizations guardrail that caps what *any*
    principal in an account can do, even admins. My Free-plan account's SCP denied ECS/RDS/S3
    creation, so I pivoted to an emulator plus validated IaC.
19. **How would GitHub Actions deploy to AWS without keys?** An OIDC provider plus a role whose trust
    policy pins `aud=sts.amazonaws.com` and `sub=repo:<org>/<repo>:ref:refs/heads/main`. Terraform is in `infra/static-site`.

### Operations / cost / leadership
20. **How do you monitor it?** Structured JSON logs (CloudWatch Logs Insights), business metric
    `LoanDecisions`, DLQ-depth alarm, CloudFront/ECS metrics, a budget alert.
21. **How do you control AWS cost?** Budgets with forecast alerts, Graviton, no idle NAT/ALB in dev,
    log retention, ECR lifecycle rules, PAY_PER_REQUEST DynamoDB, S3 Bucket Keys (fewer KMS calls),
    low-cardinality metric dimensions.
22. **How would you deploy with zero downtime?** ECS rolling deploy with a circuit breaker and rollback.
    Expand/contract migrations run as a one-off task before the service update.
23. **As a tech lead, how would you roll this out to a team?**
    - Shared Terraform modules and CI checks (fmt, validate, tests against an emulator).
    - Separate AWS accounts per environment.
    - ADRs for decisions like outbox vs CDC.
    - Runbooks for DLQ redrive.

### Questions to ask Faraz
- How is DataLendly's AWS organized (accounts per env, SCPs, landing zone)?
- Which compute dominates today, ECS or Lambda, and what's driving changes?
- How do you handle tenant isolation and data residency for lenders?
- What does the on-call / incident process look like for payment-affecting issues?

## 5. Challenges I actually hit (good stories)

1. **Superusers bypass RLS.** I created a `NOSUPERUSER NOBYPASSRLS` app role and used `FORCE`.
   On RDS a one-off ECS task creates it, so the app never holds master credentials.
2. **My AWS account couldn't deploy anything.** I read the explicit-deny errors, found the
   Organizations SCP, probed which actions were allowed, and adapted: emulator plus validated IaC,
   with real AWS used only where allowed.
3. **LocalStack's free image was retired (Mar 2026).** I switched to moto (Apache-2.0) and kept the
   Terraform identical by overriding provider endpoints.
4. **Prisma has no RLS DSL.** I hand-wrote policies in migration SQL and route every query through a
   `withTenant()` transaction.
5. **Presigned PUT can't cap file size.** I switched to presigned POST with `content-length-range`.
6. **Login before tenant context.** RLS hides users until the tenant is known, so login takes a company ID.

## 6. How to demo in 5 minutes

1. Open https://mini-loan-saas-demo.pages.dev → "Acme · Admin". Show the dashboard, a pending loan,
   approve it, and the generated schedule.
2. Log out → "Bluebird · Admin". Acme's data is gone (tenant isolation).
3. Locally (`npm run dev` with Docker up): create a customer with a national ID (masked; Reveal is
   audited), approve a large loan, then show the worker log `event_processed` with SES and SNS ids.
4. Show `infra/modules/app-services` used by both `infra/local` and `infra/`.
5. Run `scripts/validate-iam-policies.sh` on the real account: 0 findings.
