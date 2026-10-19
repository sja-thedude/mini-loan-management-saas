# Architecture

## Goals and constraints

- One deployable web app + one API. No microservice sprawl. Asynchronous work goes to **one** worker.
- Strong tenant isolation, exact money math, reliable events, an audit trail.
- $0 to run: the AWS account is a Free-plan account whose SCP blocks most services
  (see [AWS_SERVICES.md](AWS_SERVICES.md)). The same code and Terraform target three environments.

## Three environments, one codebase

| | Public demo | Local full stack | AWS production design |
|---|---|---|---|
| Hosting | Cloudflare Pages | Laptop (Docker) | ECS Fargate + Lambda |
| API | In-browser mock (same rules) | Express API | Express API in Fargate |
| Database | Browser localStorage | Postgres 16 (Docker) | RDS PostgreSQL |
| AWS services | — | moto emulator on :4566 | Real services |
| IaC | — | `infra/local` → `modules/app-services` | `infra/` → `modules/app-services` |
| Status | **Live** | **Running + tested** | **Validated, not applied** |

## Request path (synchronous)

```
Browser ──► Next.js (:3001) ──/api/* rewrite──► Express API (:4000)
                                                   │  JWT (httpOnly cookie) → tenantId, role
                                                   │  Zod validation
                                                   ├──► PostgreSQL  (withTenant: SET LOCAL app.tenant_id → RLS)
                                                   ├──► KMS         (encrypt/decrypt PII, tenant encryption context)
                                                   ├──► S3          (sign presigned POST/GET; bytes never pass through API)
                                                   ├──► CloudWatch  (PutMetricData, fire-and-forget)
                                                   └── startup: Secrets Manager (JWT key), SSM (config)
```

## Event path (asynchronous)

```
API transaction ─┬─ UPDATE loans SET status='APPROVED'
                 ├─ INSERT installments
                 ├─ INSERT audit_logs
                 └─ INSERT outbox_events   ◄── same COMMIT: no "saved but never announced"
                                │
  Outbox publisher (in API, every 1s, FOR UPDATE SKIP LOCKED) ──PutEvents──► EventBridge bus
                                                                               │ rule: source=loan-app.api
                                                                               ▼
                                                     SQS loan-events ──(5 failures)──► SQS DLQ ──► alarm
                                                                               │
                                       Lambda worker (local: runner with the same handler)
                                         1. DynamoDB conditional put {tenantId,eventId}  ← dedupe
                                         2. SES email to the customer (approved / rejected)
                                         3. SNS ops alert if principal ≥ SSM threshold
                                         4. DynamoDB status DONE (or FAILED → retry)
                                         returns batchItemFailures (only failed messages retry)
```

**Delivery semantics.** The outbox gives at-least-once publishing: a crash after PutEvents but
before marking the row means a re-send. SQS is at-least-once. The worker's conditional write on
`eventId` turns that into **effectively-once side effects**.

**Why this shape.**
- EventBridge decouples producers from consumers. New consumers (fraud scoring, a ledger export,
  analytics) add a rule without touching the API.
- SQS adds buffering, retries and a DLQ in front of the worker.
- Lambda scales the worker with no servers, and its concurrency is capped (5) to protect SES quotas.

## AWS production topology (`infra/`)

```
Internet ─► (prod: CloudFront + WAF + ALB/ACM) ─► ECS Fargate task (ARM64) in public subnet*
                                                 web :3001 ─localhost─► api :4000
                                                    │5432 (SG→SG)          │ HTTPS
 Private subnets (no internet route)               ▼                       ▼
   RDS PostgreSQL (encrypted, private)      KMS · S3 · EventBridge · SQS · SNS · SES
                                            DynamoDB · SSM · Secrets Manager · CloudWatch
 Lambda worker ◄── SQS event-source mapping (partial batch failures)
 Cognito user pool (template; future auth)
 * cost trade-off: no NAT Gateway / ALB in the learning design. See "Production hardening".
```

IAM identities:
- **ECS execution role:** pulls from ECR, writes logs, injects the DB password secret.
- **API task role** (module): S3 under `tenants/*`, KMS on one key, `events:PutEvents` on one bus,
  `ssm:GetParameter*` under `/loan-app/<env>/`, one secret, and `PutMetricData` limited to the `LoanApp` namespace.
- **Worker role** (module): consume one queue, `PutItem`/`Query` on one table, `ses:SendEmail`
  from one address, publish to one topic, write to one log group.

## Multi-tenant data model

Shared schema with `tenant_id` on every business table. Isolation is enforced in four layers:

1. **API:** the tenant comes only from the verified JWT. Every query filters by it. Cross-tenant ids return **404**.
2. **Postgres RLS:** `FORCE ROW LEVEL SECURITY` on a `NOSUPERUSER NOBYPASSRLS` role. Policies compare
   `tenant_id = current_setting('app.tenant_id')`, set transaction-locally. It fails closed.
3. **Composite foreign keys:** `(tenant_id, customer_id) → customers(tenant_id, id)`.
4. **Crypto and storage:**
   - KMS encryption context `{tenantId}` makes PII undecryptable outside its tenant.
   - S3 keys are prefixed `tenants/<tenantId>/`.
   - DynamoDB is partitioned by `tenantId`.
   - Idempotency keys are scoped per tenant.

```
tenants ─┬─ users (tenant_id,email unique)
         ├─ customers (national_id_ciphertext + last4, KMS)
         │     └─ loans ─┬─ installments
         │               └─ documents (S3 key tenants/<tid>/loans/<lid>/<uuid>)
         ├─ audit_logs   (append-only: SELECT/INSERT policies only)
         └─ idempotency_keys (tenant_id,key PK, RLS)
outbox_events (system table, no RLS, never exposed by the API; partial index on unpublished)
```

## Financial integrity

- **Money:** BIGINT cents, basis-point rates, BigInt fixed-point amortization. The last installment absorbs rounding.
  DB `CHECK` constraints enforce `total = principal + interest`.
- **State machine:** conditional `UPDATE … WHERE status='PENDING'`, so double-approval is impossible (409).
- **Idempotency-Key** on loan creation and payments:
  - The key row is inserted first, so a concurrent duplicate gets 409.
  - A retry replays the stored response.
  - Reusing a key with a different body gets 422.
  - A 5xx releases the key.
- **Atomicity:** audit row + outbox event + state change in one transaction.

## Production hardening (not built, by design or cost)

- CloudFront + WAF + ALB (ACM TLS) in front.
- ECS in private subnets with VPC endpoints instead of a NAT gateway.
- RDS Multi-AZ, RDS Proxy, longer backups.
- Cognito instead of in-house auth.
- Separate migration task in CI/CD.
- Terraform remote state (S3 + locking), multi-account (Organizations).
- CloudTrail org trail + GuardDuty + Security Hub.
- An SQS FIFO or ledger table if strict ordering per loan becomes a requirement.
