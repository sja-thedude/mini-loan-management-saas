import { randomUUID } from "node:crypto";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { GetSendQuotaCommand, SESClient } from "@aws-sdk/client-ses";
import { GetQueueUrlCommand, PurgeQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSEvent } from "aws-lambda";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handler, resetConfigCache } from "../src/handler";

// Requires the local emulator + `npm run aws:bootstrap` (see README).
const ddb = new DynamoDBClient({});
const ses = new SESClient({});
const sqs = new SQSClient({});
let opsInbox = "";

const sentCount = async () => (await ses.send(new GetSendQuotaCommand({}))).SentLast24Hours ?? 0;
const record = (type: string, detail: Record<string, unknown>, messageId = randomUUID()): SQSEvent["Records"][number] => ({
  messageId, receiptHandle: "rh", md5OfBody: "", eventSource: "aws:sqs", eventSourceARN: "arn", awsRegion: "us-east-1",
  attributes: { ApproximateReceiveCount: "1" } as SQSEvent["Records"][number]["attributes"], messageAttributes: {},
  body: JSON.stringify({ "detail-type": type, source: "loan-app.api", detail }),
});
const approved = (principalCents: string) => ({
  eventId: randomUUID(), tenantId: randomUUID(), occurredAt: new Date().toISOString(),
  data: { loanId: randomUUID(), principalCents, annualRateBps: 1200, termMonths: 12, recipient: { email: "ava@customers.example", fullName: "Ava Fictional" } },
});
const status = async (d: { tenantId: string; eventId: string }) =>
  (await ddb.send(new GetItemCommand({ TableName: process.env.NOTIFICATIONS_TABLE, Key: { tenantId: { S: d.tenantId }, eventId: { S: d.eventId } } }))).Item?.status?.S;

beforeAll(async () => {
  opsInbox = (await sqs.send(new GetQueueUrlCommand({ QueueName: "loan-app-local-ops-alerts-inbox" }))).QueueUrl!;
});
beforeEach(() => {
  delete process.env.NOTIFICATION_SENDER;
  resetConfigCache();
});

describe("notification worker (Lambda handler)", () => {
  it("sends one email per approval and records it in DynamoDB", async () => {
    const before = await sentCount();
    const d = approved("1200000");
    const res = await handler({ Records: [record("loan.approved", d)] });
    expect(res.batchItemFailures).toEqual([]);
    expect(await sentCount()).toBe(before + 1);
    expect(await status(d)).toBe("DONE");
  });

  it("is idempotent: a redelivered event (same eventId) causes no second email", async () => {
    const d = approved("1200000");
    await handler({ Records: [record("loan.approved", d)] });
    const after1 = await sentCount();
    const res = await handler({ Records: [record("loan.approved", d), record("loan.approved", d)] });
    expect(res.batchItemFailures).toEqual([]);
    expect(await sentCount()).toBe(after1);
  });

  it("publishes an SNS ops alert for high-value approvals (>= SSM threshold)", async () => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: opsInbox }));
    const d = approved("7500000"); // 75,000.00 >= 50,000.00 threshold from Parameter Store
    await handler({ Records: [record("loan.approved", d)] });
    const msgs = await sqs.send(new ReceiveMessageCommand({ QueueUrl: opsInbox, WaitTimeSeconds: 2 }));
    expect(msgs.Messages?.map((m) => JSON.parse(m.Body!).loanId)).toContain(d.data.loanId);
  });

  it("reports only the failing message (partial batch failure), then succeeds on retry", async () => {
    const good = approved("100000");
    const bad = approved("100000");
    process.env.NOTIFICATION_SENDER = "unverified@not-verified.example"; // SES rejects unverified senders
    resetConfigCache();
    const badRecord = record("loan.approved", bad);
    const res1 = await handler({ Records: [badRecord] });
    expect(res1.batchItemFailures).toEqual([{ itemIdentifier: badRecord.messageId }]);
    expect(await status(bad)).toBe("FAILED");

    delete process.env.NOTIFICATION_SENDER;
    resetConfigCache();
    const res2 = await handler({ Records: [record("loan.approved", good), badRecord] }); // SQS redelivers the failed one
    expect(res2.batchItemFailures).toEqual([]);
    expect(await status(bad)).toBe("DONE");
    expect(await status(good)).toBe("DONE");
  });

  it("rejects malformed events without poisoning the batch", async () => {
    const ok = approved("100000");
    const broken = { ...record("loan.approved", {}), body: "{not json" };
    const res = await handler({ Records: [record("loan.approved", ok), broken] });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: broken.messageId }]);
    expect(await status(ok)).toBe("DONE");
  });
});
