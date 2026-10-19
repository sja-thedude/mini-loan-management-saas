# AWS Learning Notes

Written for someone fluent in Supabase, Cloudflare, Docker and GitHub Actions who is new
to AWS. Each section covers what the service is, how it maps to what you know, the
differences that matter, and where it appears in this project.

## The mental model: AWS is building blocks you wire together

Supabase and Cloudflare are **platforms**: auth, database, storage and networking come
pre-wired. AWS gives you **primitives** that you connect yourself, and nothing can talk to
anything until you allow it. That is more work, but it also means more control and a
clearer audit trail, which is why regulated industries like lending use it.

Two questions decide almost every AWS setup:
1. **Network:** can packets get from A to B? (VPC, subnets, route tables, security groups)
2. **Identity:** is A allowed to call B's API? (IAM)

Both must say yes.

---

## Regions and Availability Zones

- A **region** (e.g. `us-east-1`) is a separate geographic deployment. Most resources live in
  exactly one region, which matters for data residency (e.g. keeping UK customer data in
  `eu-west-2`).
- An **Availability Zone (AZ)** is one or more physically separate data centers inside a region.
  You get high availability by spreading across AZs.
- *Compared with Cloudflare:* Workers run in every location automatically. On AWS **you choose**
  where things run, and cross-region is something you build.
- *This project:* one region, two AZs (RDS requires a subnet group that spans two AZs).

## IAM: Identity and Access Management

- **Users / Identity Center:** humans. Use IAM Identity Center (SSO) so the CLI gets
  **temporary** credentials (`aws configure sso`). Avoid long-lived access keys.
- **Roles:** identities that services or people *assume* for temporary credentials. No password,
  no keys.
- **Policies:** JSON documents of `Effect / Action / Resource / Condition`. Anything not
  explicitly allowed is denied, and an explicit deny always wins.
- **Least privilege:** grant specific actions on specific ARNs, e.g. `s3:GetObject` on
  `arn:aws:s3:::bucket/tenants/*`, not `s3:*` on `*`.
- *Compared with Supabase:* the `service_role` key is one permanent all-powerful secret.
  IAM is per-identity and per-action, with short-lived credentials, and every call is logged
  (CloudTrail).
- *This project:* two ECS roles.
  - **Execution role:** the ECS agent pulls images, reads secrets and writes logs.
  - **Task role:** your code can only `PutObject`/`GetObject` under `tenants/*` in one bucket.

## VPC: Virtual Private Cloud

- Your own private network (`10.0.0.0/16`) inside a region.
- **Subnet:** a slice of the VPC in one AZ. Whether it is "public" or "private" depends **only
  on its route table**:
  - public: has a route `0.0.0.0/0 → Internet Gateway`
  - private: has no such route
- **Internet Gateway:** free, and allows two-way internet traffic for resources with public IPs.
- **NAT Gateway:** lets private resources reach *out* to the internet. It costs ~$33/mo plus data,
  so this project avoids it.
- **VPC endpoints:** private access to AWS services without the internet (~$7/mo each per AZ).
  The production alternative to NAT.
- *Compared with Supabase/Cloudflare:* there is no equivalent. Their networking is fully managed
  and invisible. This is the biggest new concept.

## Security groups

- **Stateful** virtual firewalls attached to network interfaces (ENIs). If inbound traffic is
  allowed, the reply is allowed automatically.
- Allow-rules only. There are no deny rules (for those, use Network ACLs at the subnet level).
- A rule's source can be **another security group**, meaning "anything wearing SG X". This is
  how the DB allows only the app, without hard-coding IPs that change.
- *This project:* `app` SG allows `3001` from your IP only. `db` SG allows `5432` only from `app` SG.

## Amazon RDS: managed relational database

- AWS runs Postgres for you: patching, automated backups, point-in-time restore, encryption,
  optional Multi-AZ standby.
- *Compared with Supabase Postgres:* both are managed Postgres. **But RDS is just the database.**
  It has no auth, no auto-generated REST API, no dashboard SQL editor, no connection pooler by
  default (RDS Proxy is extra), and no built-in RLS setup. It lives inside **your** VPC, so by
  default nothing on the internet can reach it, which is what you want.
- The master user is not a true superuser (`rds_superuser`). You cannot SSH to the host.
- `manage_master_user_password = true` makes RDS generate the master password and store it in
  Secrets Manager. Even Terraform never sees it.
- *This project:* `db.t4g.micro`, 20 GB gp3, encrypted, private, 1-day backups. A one-off ECS task
  creates the least-privilege `loan_app` role, so the app never holds master credentials.

## Amazon ECR: Elastic Container Registry

- A private Docker registry, like GHCR or Docker Hub private repos. It is IAM-authenticated
  (`aws ecr get-login-password | docker login …`), can scan images for CVEs on push, and uses
  lifecycle rules to delete old images (storage is billed).

## Amazon ECS on Fargate: running containers

- **Cluster:** a logical grouping. With Fargate there are no servers to manage.
- **Task definition:** a versioned JSON "compose file" listing images, CPU/memory, env, secrets,
  ports, health checks, logging and IAM roles.
- **Task:** one running instance of a task definition (one or more containers).
- **Service:** keeps N tasks running, replaces unhealthy ones, and does rolling deploys.
  The deployment circuit breaker rolls back automatically if new tasks fail health checks.
- **awsvpc network mode:** each task gets its own ENI and IP, and containers in a task share
  `localhost`. This is how web reaches the API here.
- *Compared with Cloudflare Workers / Lambda:* Workers are per-request V8 isolates with no
  servers, millisecond cold starts, billed per request, and limited runtimes. **Fargate runs your
  normal long-lived container**, billed per second while running, with any language, connection
  pools and background work. Lambda sits between the two: per-invocation functions, with
  awkwardness around DB connections.
- Fargate is billed for the whole time a task runs, even when idle. Set `desired_count = 0` to stop.

## Amazon S3: object storage

- Buckets hold objects (files). The bucket name is globally unique. Bucket and object access is
  controlled by IAM policies **and** bucket policies.
- **Block Public Access** stops anyone from making it public by accident. **Object Ownership =
  BucketOwnerEnforced** disables legacy ACLs.
- **Presigned URLs:** your server (holding IAM credentials) signs a URL that grants one operation
  on one object for N seconds. The browser uses it directly.
  - *Presigned POST* can enforce a size range and content type. A presigned PUT cannot.
- *Compared with Cloudflare R2:* the S3 API is the same (R2 copied it). The differences:
  - S3 charges **egress** (data out); R2 doesn't.
  - S3 access is IAM-integrated (roles, conditions, CloudTrail).
  - S3 has storage classes (IA, Glacier) and lifecycle rules.
- *This project:* private bucket, AES256 encryption, a bucket policy that denies non-TLS access,
  keys prefixed `tenants/<tenantId>/…`, 5-minute upload URLs and 60-second download URLs.

## AWS Secrets Manager

- Stores secrets encrypted with KMS, supports rotation, and access is IAM-controlled and audited.
  ~$0.40 per secret per month.
- ECS injects secrets as env vars at container start: `valueFrom = "<secret-arn>:JSON_KEY::"`.
  The secret never appears in the image, the repo, or the task definition.
- *Compared with* Cloudflare Worker secrets / GitHub Actions secrets: similar idea, but it is
  IAM-scoped per role, audit-logged, and supports rotation.
- **SSM Parameter Store (SecureString)** is a free alternative without built-in rotation.

## Amazon CloudWatch

- **Logs:** ECS's `awslogs` driver ships container stdout/stderr to a **log group**, one
  **log stream** per container. Set retention (default is forever, and storage is billed).
- **Logs Insights:** query structured logs, e.g.
  `fields @timestamp, path, status, ms | filter status >= 500 | sort @timestamp desc`.
  That is why the API logs one JSON object per line.
- **Metrics/Alarms:** ECS publishes CPU/memory. You can alarm on them or on log-based metrics.
- *Compared with* Cloudflare Workers Logs / Supabase logs: similar, but you set it up yourself.

## AWS Budgets

- Monthly cost or usage budgets with email/SNS alerts on actual or **forecasted** spend.
- **It does not stop spending.** It only alerts. (Budget actions can apply IAM policies, which is advanced.)
- The first two budgets are free. Create one **before** creating anything else.

## Amazon Cognito (not used: comparison only)

- Managed user directory plus OAuth/OIDC, like Supabase Auth.
- Differences: more configuration (user pools, app clients, hosted UI), and multi-tenancy needs
  design work (custom attributes like `custom:tenant_id`, groups, or a pool per tenant).
- This project uses its own bcrypt + JWT auth for speed. In production you'd move to Cognito or
  another IdP to get MFA, password policies and account recovery.

## Other mappings

| You know | AWS | Key difference |
|---|---|---|
| Cloudflare Pages | Amplify Hosting / S3 + CloudFront | CloudFront is a CDN you configure (behaviors, origins, cache policies). Amplify is closer to Pages. |
| Cloudflare Workers | Lambda (+ API Gateway / Function URLs) | Lambda runs in regions, not at the edge (Lambda@Edge / CloudFront Functions are edge but limited) |
| GitHub Actions secrets | OIDC → IAM role | Actions get temporary AWS credentials, so there are no stored keys |
| GitHub Actions deploy | CodePipeline / CodeBuild | Most teams keep GitHub Actions and use OIDC to deploy to AWS |

## How it all connects in this project

1. You push images to **ECR** (authenticated via **IAM**/SSO).
2. The **ECS service** launches a **Fargate task** in a **public subnet** of the **VPC**.
3. The **execution role** lets ECS pull images and read **Secrets Manager**.
4. The task's **security group** allows inbound traffic only from your IP. The **RDS** security
   group allows inbound only from the task's SG. RDS sits in **private subnets**.
5. App code uses the **task role** to sign **S3** presigned URLs.
6. All container output lands in **CloudWatch Logs**.
7. **Budgets** emails you before any of this gets expensive.

---

# Part 2: Event-driven and security services (implemented against the local emulator)

## Amazon EventBridge
- A serverless **event bus**. Producers `PutEvents`; **rules** match on event content (source, detail-type,
  fields) and route to **targets** (SQS, Lambda, Step Functions, another bus…).
- *Compared with* Supabase webhooks / Cloudflare Queues: those deliver to one place. EventBridge routes
  by content to many places, and adding a consumer doesn't touch the producer.
- `PutEvents` is **not atomic**: always check `FailedEntryCount` / each entry's `ErrorCode`. The outbox
  publisher does.
- *Here:* bus `loan-app-<env>-events`, rule on `source = loan-app.api` with five detail-types, target = SQS.

## Amazon SQS
- A durable queue. A consumer receives a message, which becomes invisible for the **visibility timeout**, then deletes it.
  If it isn't deleted, it reappears; after **maxReceiveCount** it moves to the **dead-letter queue**.
- Standard queues are at-least-once and unordered (FIFO queues: ordered, exactly-once *within* SQS, lower throughput).
- **Long polling** (`WaitTimeSeconds=20`) cuts empty receives and cost.
- *Compared with* Cloudflare Queues: very similar model. SQS adds DLQ redrive and resource policies.
- *Here:* events queue (visibility 60 s > Lambda timeout 30 s) + DLQ (14-day retention), queue policy
  allowing only the EventBridge rule.

## Amazon SNS
- Pub/sub fan-out: one publish, many subscribers (SQS, Lambda, email, SMS, HTTP).
- *Here:* `ops-alerts` topic for high-value approvals. Locally an SQS queue subscribes (raw delivery) so tests can assert it.

## Amazon SES
- Transactional email. New accounts start in the **sandbox**: you can only send to verified addresses
  until you request production access. Senders must be verified identities (domain or email).
- *Here:* the worker sends approval/rejection emails. An unverified sender is rejected; the test uses that to exercise the retry path.

## AWS Lambda
- Functions run per event, billed per ms; up to 15 minutes; concurrency scales automatically (cap it with
  reserved or maximum concurrency). Code outside the handler runs once per **cold start**: reuse clients there.
- **SQS event-source mapping:** Lambda polls the queue and invokes with batches. With
  `ReportBatchItemFailures`, the handler returns only the failed message IDs.
- *Compared with* Cloudflare Workers: Workers are per-request isolates at the edge with ms cold starts.
  Lambda is regional, supports long-running and VPC-attached work, and integrates with every AWS event source.
- *Here:* `apps/worker/src/handler.ts` is a real Lambda handler. `local-runner.ts` mimics the event-source
  mapping. The production Terraform is in `infra/lambda.tf`.

## Amazon DynamoDB
- Serverless key-value/document DB. Design by **access pattern**: partition key (+ sort key).
  Writes can be **conditional** (`attribute_not_exists`), which gives atomic "claim once" semantics without locks.
- TTL deletes expired items for free. PITR provides backups. On-demand billing.
- *Compared with* Postgres: no joins, no ad-hoc queries; predictable single-digit-ms at any scale.
- *Here:* notification log, partition `tenantId`, sort `eventId`, conditional claim = idempotency.

## AWS KMS
- Managed encryption keys (HSM-backed). **Customer managed keys** (CMKs) have key policies, rotation and a
  CloudTrail record of every use.
- `Encrypt` handles up to 4 KB. Larger data uses **envelope encryption** (`GenerateDataKey` → encrypt locally → store the
  encrypted data key).
- **Encryption context:** non-secret key/value pairs bound to the ciphertext. Decrypt must present the
  same context. *Here:* `{tenantId, field}`, so another tenant's context fails.
- Integrations: S3 SSE-KMS (Bucket Keys reduce KMS calls), SNS, SQS, DynamoDB, Secrets Manager, RDS, EBS.

## AWS Systems Manager Parameter Store vs AWS Secrets Manager
| | Parameter Store | Secrets Manager |
|---|---|---|
| Use for | Config, feature flags (and simple secrets as SecureString) | Credentials needing rotation/audit |
| Cost | Standard tier free | ~$0.40/secret/month + API calls |
| Rotation | No built-in | Built-in (Lambda rotation; RDS-managed) |
*Here:* threshold + sender in SSM; JWT key in Secrets Manager; RDS master password managed by RDS in Secrets Manager.

## AWS CloudTrail
- Records AWS API calls (who, what, when, from where). **Event history** (90 days of management events) is free and on by default.
  Trails deliver to S3/CloudWatch for long-term retention and data events.
- *Here:* `aws cloudtrail lookup-events` on the real account showed our own calls.

## IAM Access Analyzer
- **Policy validation** (`ValidatePolicy`): linting for IAM policies, covering errors, security warnings and suggestions.
  It also finds resources shared outside your account, and unused access.
- *Here:* validated on the real account: 0 findings for our policies; the bad example is flagged.

## AWS Organizations and SCPs
- Organizations groups accounts. **Service Control Policies** set the *maximum* permissions in member accounts.
  Even an admin can't exceed them. An explicit deny in an SCP always wins.
- *Here:* the Free-plan account is a member of an AWS-managed org whose SCP denies most services. That is
  why ECS/RDS/S3 couldn't be created. Diagnosing this is a realistic enterprise skill.

## Amazon Cognito (template)
- User pools: sign-up/in, MFA, password policy, hosted UI, OAuth/OIDC tokens. Identity pools: temporary AWS credentials.
- Multi-tenancy: an immutable `custom:tenant_id` attribute (not client-writable) and groups for roles. The API
  verifies JWTs against the pool's JWKS.
- *Compared with* Supabase Auth: similar features, more configuration, AWS-native integration (ALB/API Gateway authorizers).

## Not used (and how they'd fit)
- **API Gateway:** a managed HTTP front door for Lambda (auth, throttling, usage plans). Not needed with ECS + Next.js.
- **EC2:** VMs. Fargate removes host patching.
- **CloudFormation:** AWS-native IaC (CDK compiles to it). Terraform chosen for multi-cloud familiarity.
- **Route 53 / ACM:** DNS ($0.50/zone/month) and free TLS certificates for a custom domain.
- **Cost Explorer:** console is free; the API costs $0.01/request.
