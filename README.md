# Mini Loan Management SaaS

A small **multi-tenant loan management** app built as a hands-on AWS learning project.
Companies (tenants) manage customers, take loan applications, approve or reject them,
track repayment schedules, and review an audit log. Each company's data is isolated
from every other company's.

> **Learning project — fictional data only.** Production-inspired practices, but **not**
> a production-ready financial system (see [SECURITY.md](SECURITY.md) for the gaps).

## Status

| Area | Status |
|---|---|
| **AWS (eu-north-1)** | ✅ **Deployed**: ECS Fargate, Aurora Serverless v2, Lambda, SQS, EventBridge, SNS, SES, DynamoDB, KMS, S3, Secrets Manager, SSM, CloudWatch, X-Ray, CloudTrail, Scheduler, Cognito, CloudFront (Terraform) |
| AWS static demo (S3 + CloudFront) | ✅ https://da2lxef9ohfff.cloudfront.net |
| Full app on AWS | ✅ On demand: `scripts/app.sh start` (≈ $0.09/h while running; idle ≈ $2/month) |
| Cloudflare Pages mirror | ✅ https://mini-loan-saas-demo.pages.dev |
| Tests | ✅ 48 automated tests (API, AWS integration against an emulator, worker, demo); CI green |

See [AWS_SERVICES.md](AWS_SERVICES.md) for the full, verified inventory.

## Stack

- **Web:** Next.js 15, TypeScript, Tailwind CSS 4 (server build or static demo build)
- **API:** Node.js 22, Express 5, Zod, JWT (httpOnly cookie), Prisma 6, PostgreSQL 16 + row-level security
- **Worker:** AWS Lambda handler (SQS batch, partial failures), with a local SQS runner
- **AWS:** KMS, S3, EventBridge, SQS, SNS, SES, DynamoDB, SSM Parameter Store, Secrets Manager, CloudWatch,
  IAM, plus ECS Fargate, ECR, RDS, Lambda, Cognito, VPC, CloudFront in Terraform
- **Infra:** Terraform (one shared module for emulator and production), Docker, GitHub Actions, Cloudflare Pages

## Run locally

Prereqs: Node 20+, Docker Desktop, Terraform.

```bash
npm install
docker compose up -d --wait        # Postgres :5433 + AWS emulator :4566
npm run aws:bootstrap              # provision emulated AWS resources (Terraform)
cp .env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
npm run db:migrate && npm run db:seed
npm run dev                        # web http://localhost:3001 · api :4000 · worker
npm test                           # 47 tests
npm run dev:demo                   # static demo mode (no DB, no AWS)
```

Sign in with company `acme` or `bluebird`, email `admin@<company>.example` (or `officer@…`),
password `DemoPassword123!`.

## Features

1. Authentication — company ID + email + password, bcrypt, 8h JWT in httpOnly cookie, rate-limited login
2. Tenant management — self-service company registration, admin can add users (ADMIN / OFFICER)
3. Customers — create, search, list
4. Loan applications — principal, rate, term, purpose
5. Approve / reject — ADMIN only, race-safe state transition
6. Status tracking — PENDING → APPROVED/REJECTED → CLOSED (when fully repaid)
7. Repayment schedule — amortized, integer-cent BigInt math, projected for pending loans
8. Dashboard — counts, outstanding principal/interest, overdue installments
9. Audit log — append-only (enforced by the database)
10. Tenant isolation — API filter **and** Postgres row-level security
11. Loan documents — S3 presigned POST upload / presigned GET download, SSE-KMS
12. PII encryption — national IDs encrypted with KMS (tenant-bound encryption context); admin-only, audited reveal
13. Idempotency keys — retried loan creation / payment can't duplicate
14. Async notifications — transactional outbox → EventBridge → SQS (+DLQ) → worker → SES email, SNS ops alert, DynamoDB log

## Repo layout

```
apps/api/         Express API, Prisma schema + migrations, tests, Dockerfile
apps/web/         Next.js frontend (+ static demo mode with in-browser mock API), Dockerfile
apps/worker/      Lambda handler for loan events + local SQS runner, tests
infra/            Production Terraform (VPC, RDS, ECS, Lambda, Cognito…)
infra/modules/app-services/  Shared module: KMS, S3, EventBridge, SQS, SNS, SES, DynamoDB, SSM, Secrets, IAM
infra/local/      Same module against the local AWS emulator
infra/static-site/  S3 + CloudFront + GitHub OIDC (blocked by account SCP; kept as IaC)
scripts/          IAM Access Analyzer policy validation
docker/           Local Postgres init (creates non-superuser app role)
.github/workflows CI: typecheck, tests against Postgres, image builds
```

## Docs

- [AWS_SERVICES.md](AWS_SERVICES.md) — every AWS service: real / emulated+tested / IaC-only, with costs
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit
- [AWS_LEARNING_NOTES.md](AWS_LEARNING_NOTES.md) — AWS concepts, compared to Supabase/Cloudflare
- [DEPLOYMENT.md](DEPLOYMENT.md) — step-by-step AWS runbook
- [SECURITY.md](SECURITY.md) — controls in place and known gaps
- [INTERVIEW_PREPARATION.md](INTERVIEW_PREPARATION.md) — how to talk about this project
