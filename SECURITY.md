# Security

Learning project with **fictional data**. This lists what is actually implemented and,
just as importantly, what a real lending platform would still need.

## Implemented

### Authentication & sessions
- bcrypt (cost 12) password hashing. Minimum length 10.
- Login needs company ID + email + password, and returns one generic error message for any
  failure. Timing is equalized against a dummy hash so valid emails can't be detected.
- Rate limiting: 20 attempts per 15 minutes per IP on login/register.
- 8-hour HS256 JWT in an **httpOnly, SameSite=Lax** cookie, so JavaScript can't read it and
  cross-site POSTs don't carry it. The algorithm is pinned on verify, and claims are validated.
- Role-based access control: only ADMIN can approve/reject, create users, or read the audit log.

### Tenant isolation (defense in depth)
- The tenant comes **only** from the verified token.
- The API filters every query by tenant. Cross-tenant ids return 404.
- Postgres **row-level security** with `FORCE`, through a `NOSUPERUSER NOBYPASSRLS` role. It fails
  closed when no tenant is set.
- Composite foreign keys stop cross-tenant references at the schema level.
- Tests prove all of this, including an *unfiltered* query returning only the current tenant's rows.

### Data integrity
- Integer cents (BigInt). No floating-point money. DB `CHECK` constraints on amounts.
- Race-safe state transitions using conditional `UPDATE`.
- Audit log is written in the same transaction as the change, and is **append-only**:
  the database has no UPDATE/DELETE policy for it.

### Encryption & secrets (tested against the local AWS emulator)
- **KMS field-level encryption** of national IDs. Only ciphertext + last 4 digits are stored. The encryption context
  `{tenantId, field}` makes a ciphertext undecryptable under any other tenant (tested). Reveal is ADMIN-only,
  audited (`customer.pii_revealed`), and sent with `Cache-Control: no-store`. KMS is called **before** the DB transaction opens.
- CMK with automatic rotation. SSE-KMS on the documents bucket (Bucket Keys on), SNS topic, DynamoDB table, Secrets Manager secret.
- JWT signing key in **Secrets Manager**, loaded at startup. Non-secret config in **SSM Parameter Store**.

### Financial integrity
- **Idempotency-Key** on loan creation and payments: insert-first (a concurrent duplicate gets 409), replay on retry,
  422 on a key reused with a different body, tenant-scoped with RLS.
- **Transactional outbox:** events commit atomically with state changes. The worker deduplicates on `eventId`
  with a DynamoDB conditional write.

### IAM
- Separate least-privilege roles for the API and worker. Resource-scoped ARNs; condition keys where there are no
  resource ARNs (`cloudwatch:namespace`, `ses:FromAddress`). Validated on real AWS with **IAM Access Analyzer**
  (`scripts/validate-iam-policies.sh`: 0 findings).
- Queue policy allows `events.amazonaws.com` only from the specific rule ARN (confused-deputy protection).

### Audit & operations (deployed)
- **CloudTrail** trail with log file integrity validation → encrypted, TLS-only S3 bucket (90-day lifecycle).
- **ECS Exec** through SSM Session Manager instead of SSH (no inbound ports, sessions audited).
- Least-privilege fix found in production: the worker lacked `dynamodb:UpdateItem`. Claim leases now prevent a
  failed status update from silently dropping an event.

### Input & errors
- Zod validation on every body, query and path parameter. JSON body limit 100 KB.
- Errors return JSON without stack traces. Internals are logged server-side with a request id.
- `helmet` security headers. `x-powered-by` is disabled.

### AWS (as designed in Terraform; verify once deployed)
- RDS in private subnets, `publicly_accessible = false`, encrypted at rest, TLS required.
- DB security group accepts only the app security group.
- App security group accepts only your IP.
- Secrets in Secrets Manager, injected at runtime. The RDS master password is generated and held
  by AWS. The app uses a separate least-privilege DB role. Master credentials only reach a one-off
  bootstrap task.
- IAM: execution role vs task role. The task role can only read/write `tenants/*` in one bucket.
- S3: Block Public Access, ACLs disabled, SSE encryption, TLS-only bucket policy, presigned URLs
  with 5-minute (upload) / 60-second (download) expiry, size and type enforced by the POST policy.
- Containers run as the non-root `node` user. ECR scans images on push.
- Human access through IAM Identity Center (temporary credentials). No long-lived access keys.

## Known gaps (would be required for production)

| Gap | Why it matters | Fix |
|---|---|---|
| **No HTTPS on AWS** (direct to task IP over HTTP) | Passwords and cookies cross the internet in plaintext | ALB + ACM certificate, or CloudFront; then `COOKIE_SECURE=true` |
| Emulator doesn't enforce IAM | Policies are validated (Access Analyzer) but not exercised against real authorization | Run integration tests in a real sandbox account |
| Event payload carries customer email | PII in the event stream and SQS | Claim-check pattern (event carries IDs; worker fetches details) |
| Terraform state is local and contains generated secrets | Anyone with the file has the DB password | S3 backend with encryption + locking; restrict access |
| App task in a public subnet | Larger attack surface | Private subnets + NAT or VPC endpoints behind an ALB |
| No MFA, password reset or account lockout | Account takeover risk | Cognito / IdP with MFA |
| No JWT revocation | A stolen token is valid for up to 8h | Short access tokens + refresh tokens, or server-side sessions |
| No WAF / DDoS protections | Abuse, credential stuffing | AWS WAF on ALB/CloudFront, Shield |
| No malware scanning of uploads | Malicious files stored | S3 event → scanning (e.g. GuardDuty Malware Protection for S3) |
| No CloudTrail / GuardDuty / Config set up explicitly | Weak detection and forensics | Organization-wide CloudTrail, GuardDuty, Security Hub |
| Rate limiting is in-memory, per task | Doesn't hold across multiple tasks | WAF rate rules or Redis-backed limiter |
| No PII encryption at field level, no data retention policy | Regulatory (GDPR, GLBA, PCI if cards) | KMS envelope encryption for sensitive fields, retention jobs |
| Single-AZ DB, 1-day backups | Data loss / downtime | Multi-AZ, longer retention, cross-region snapshot copy, restore drills |
| No dependency/container scanning gate in CI | Vulnerable dependencies ship | `npm audit` / Dependabot / ECR scan results as a gate |
| Migrations run with the app role at startup | The app role owns the schema | Separate migration role and pipeline step |
| Loan maths is simplified | Real lending needs APR disclosure, day-count conventions, fees, late interest | Domain-specific rules engine, compliance review |

## Reporting

This is a personal learning repository. Don't use real personal or financial data in it.
