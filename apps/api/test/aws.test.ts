/**
 * Integration tests against the local AWS emulator (moto): KMS, S3, EventBridge, SQS, SES,
 * SNS, DynamoDB, SSM. Requires `docker compose up` + `npm run aws:bootstrap`.
 */
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, PurgeQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handler as workerHandler } from "../../worker/src/handler";
import { createApp } from "../src/app";
import { s3Client } from "../src/lib/aws";
import { prisma, withTenant } from "../src/lib/db";
import { publishOutboxBatch } from "../src/lib/outbox";
import { decryptNationalId } from "../src/lib/pii";

const app = createApp();
const PASSWORD = "CorrectHorse123!";
const sqs = new SQSClient({});
const ddb = new DynamoDBClient({});
type Session = { token: string; tenantId: string };
const as = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

async function company(slug: string): Promise<Session> {
  await request(app).post("/api/auth/register").send({ companyName: slug, companySlug: slug, fullName: "Admin", email: `admin@${slug}.test`, password: PASSWORD });
  const login = await request(app).post("/api/auth/login").send({ companySlug: slug, email: `admin@${slug}.test`, password: PASSWORD });
  const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${login.body.token}`);
  return { token: login.body.token, tenantId: me.body.tenant.id };
}

let A: Session, B: Session, customerId: string, loanId: string;

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE tenants, users, customers, loans, installments, documents, audit_logs, outbox_events, idempotency_keys CASCADE`);
  A = await company("aws-company-a");
  B = await company("aws-company-b");
});
afterAll(() => prisma.$disconnect());

describe("KMS field-level encryption of PII", () => {
  it("stores only ciphertext + last4 and returns a masked value", async () => {
    const res = await request(app).post("/api/customers").set(as(A)).send({ fullName: "Ava Fictional", email: "ava@customers.example", monthlyIncome: "6500.00", nationalId: "123-45-6789" });
    expect(res.status).toBe(201);
    customerId = res.body.id;
    expect(res.body.nationalIdMasked).toBe("***-**-6789");
    expect(res.body.nationalIdCiphertext).toBeUndefined();
    const row = await withTenant(A.tenantId, (tx) => tx.customer.findFirstOrThrow({ where: { id: customerId } }));
    expect(row.nationalIdCiphertext).toBeTruthy();
    expect(Buffer.from(row.nationalIdCiphertext!, "base64").toString("latin1")).not.toContain("123-45-6789");
  });

  it("only ADMIN can reveal, and each reveal is audited", async () => {
    const res = await request(app).get(`/api/customers/${customerId}/national-id`).set(as(A));
    expect(res.body.nationalId).toBe("123-45-6789");
    expect(res.headers["cache-control"]).toBe("no-store");
    const logs = await request(app).get("/api/audit-logs").set(as(A));
    expect(logs.body.some((l: { action: string }) => l.action === "customer.pii_revealed")).toBe(true);
    expect((await request(app).get(`/api/customers/${customerId}/national-id`).set(as(B))).status).toBe(404);
  });

  it("ciphertext is bound to its tenant by the KMS encryption context", async () => {
    const row = await withTenant(A.tenantId, (tx) => tx.customer.findFirstOrThrow({ where: { id: customerId } }));
    await expect(decryptNationalId(B.tenantId, row.nationalIdCiphertext!)).rejects.toMatchObject({ name: "InvalidCiphertextException" });
    expect(await decryptNationalId(A.tenantId, row.nationalIdCiphertext!)).toBe("123-45-6789");
  });
});

describe("idempotency keys on money-moving requests", () => {
  const body = () => ({ customerId, principal: "60000.00", annualRatePercent: "9.5", termMonths: 24, purpose: "Fictional fleet expansion" });

  it("a retried loan creation returns the original loan instead of a duplicate", async () => {
    const first = await request(app).post("/api/loans").set(as(A)).set("Idempotency-Key", "create-loan-0001").send(body());
    const retry = await request(app).post("/api/loans").set(as(A)).set("Idempotency-Key", "create-loan-0001").send(body());
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.id).toBe(first.body.id);
    loanId = first.body.id;
    const count = await withTenant(A.tenantId, (tx) => tx.loan.count({ where: { tenantId: A.tenantId } }));
    expect(count).toBe(1);
  });

  it("reusing a key with a different body is rejected (422)", async () => {
    const res = await request(app).post("/api/loans").set(as(A)).set("Idempotency-Key", "create-loan-0001").send({ ...body(), principal: "1.00" });
    expect(res.status).toBe(422);
  });

  it("keys are tenant-scoped: another tenant's identical key is independent", async () => {
    const res = await request(app).post("/api/loans").set(as(B)).set("Idempotency-Key", "create-loan-0001").send(body());
    expect(res.status).toBe(404); // B can't see A's customer: proves no cross-tenant replay
  });
});

describe("event-driven flow: outbox -> EventBridge -> SQS -> worker -> SES/SNS/DynamoDB", () => {
  it("an approval is delivered end to end exactly once", async () => {
    const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: "loan-app-local-loan-events" }))).QueueUrl!;
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));

    expect((await request(app).post(`/api/loans/${loanId}/approve`).set(as(A)).send({ note: "Meets policy" })).status).toBe(200);
    const pending = await prisma.outboxEvent.findMany({ where: { publishedAt: null } });
    expect(pending.map((e) => e.type)).toContain("loan.approved");

    while ((await publishOutboxBatch()) > 0);
    expect(await prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);

    const msgs = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
    const approvalMsg = msgs.Messages!.find((m) => JSON.parse(m.Body!)["detail-type"] === "loan.approved")!;
    const detail = JSON.parse(approvalMsg.Body!).detail;
    expect(detail.tenantId).toBe(A.tenantId);
    expect(detail.data.loanId).toBe(loanId);

    const res = await workerHandler({
      Records: [{ messageId: approvalMsg.MessageId!, receiptHandle: approvalMsg.ReceiptHandle!, body: approvalMsg.Body!, attributes: {} as never, messageAttributes: {}, md5OfBody: "", eventSource: "aws:sqs", eventSourceARN: queueUrl, awsRegion: "us-east-1" }],
    });
    expect(res.batchItemFailures).toEqual([]);
    const item = await ddb.send(new GetItemCommand({ TableName: "loan-app-local-notifications", Key: { tenantId: { S: A.tenantId }, eventId: { S: detail.eventId } } }));
    expect(item.Item?.status?.S).toBe("DONE");
    const effects = JSON.parse(item.Item!.effects!.S!);
    expect(effects.sesMessageId).toBeTruthy();
    expect(effects.snsMessageId).toBeTruthy(); // 60,000.00 >= 50,000.00 high-value threshold
  });

  it("a retried payment with the same Idempotency-Key is recorded once", async () => {
    const pay = () => request(app).post(`/api/loans/${loanId}/installments/1/pay`).set(as(A)).set("Idempotency-Key", "pay-loan-inst-1");
    const first = await pay();
    const retry = await pay();
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200); // replay, not 409 "already paid"
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    const paidEvents = await prisma.outboxEvent.count({ where: { type: "installment.paid" } });
    expect(paidEvents).toBe(1);
  });
});

describe("S3 documents: presigned POST upload, SSE-KMS, presigned GET", () => {
  it("uploads directly to S3 and downloads via a short-lived URL", async () => {
    const res = await request(app).post(`/api/loans/${loanId}/documents`).set(as(A)).send({ fileName: "bank-statement.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    const { upload, document } = res.body;
    expect(document.s3Key).toMatch(new RegExp(`^tenants/${A.tenantId}/loans/${loanId}/`));

    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields as Record<string, string>)) form.append(k, v);
    form.append("file", new Blob(["%PDF-1.4 fictional statement"], { type: "application/pdf" }), "bank-statement.pdf");
    const put = await fetch(upload.url, { method: "POST", body: form });
    expect([200, 201, 204]).toContain(put.status);

    const head = await s3Client().send(new HeadObjectCommand({ Bucket: "loan-app-local-documents", Key: document.s3Key }));
    expect(head.ServerSideEncryption).toBe("aws:kms"); // bucket default encryption with the CMK

    const dl = await request(app).get(`/api/loans/${loanId}/documents/${document.id}/download`).set(as(A));
    const file = await fetch(dl.body.url);
    expect(await file.text()).toBe("%PDF-1.4 fictional statement");
    expect((await request(app).get(`/api/loans/${loanId}/documents/${document.id}/download`).set(as(B))).status).toBe(404);
  });
});
