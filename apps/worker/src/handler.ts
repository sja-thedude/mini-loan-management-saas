/**
 * Notification worker: an AWS Lambda handler for SQS events (EventBridge -> SQS -> Lambda).
 *
 * Delivery from SQS is AT-LEAST-ONCE, so the handler makes its side effects idempotent:
 * it "claims" each eventId with a DynamoDB conditional write before sending anything.
 * Failures are reported per message (ReportBatchItemFailures): only failed messages return
 * to the queue, and after maxReceiveCount attempts they move to the dead-letter queue.
 */
import { ConditionalCheckFailedException, DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { log } from "./log";

// Clients and config are created once per container ("cold start") and reused across invocations.
const region = process.env.AWS_REGION ?? "us-east-1";
const ddb = new DynamoDBClient({ region });
const ses = new SESClient({ region });
const sns = new SNSClient({ region });
const ssm = new SSMClient({ region });

interface WorkerConfig { sender: string; highValueThresholdCents: bigint }
let configPromise: Promise<WorkerConfig> | undefined;
async function loadConfig(): Promise<WorkerConfig> {
  const prefix = process.env.SSM_PREFIX ?? "/loan-app/local";
  const get = async (name: string) => (await ssm.send(new GetParameterCommand({ Name: `${prefix}/${name}` }))).Parameter?.Value;
  return {
    sender: process.env.NOTIFICATION_SENDER ?? (await get("notification-sender")) ?? "no-reply@loan-app.example",
    highValueThresholdCents: BigInt((await get("high-value-threshold-cents")) ?? "5000000"),
  };
}
/** Test hook: forget cached config (e.g. after changing env). */
export function resetConfigCache() { configPromise = undefined; }

export interface LoanEventDetail {
  eventId: string;
  tenantId: string;
  occurredAt: string;
  data: Record<string, unknown> & { loanId: string };
}
interface EventBridgeEnvelope { "detail-type": string; source: string; detail: LoanEventDetail }

const money = (cents: string) => {
  const c = BigInt(cents);
  return `$${(c / 100n).toLocaleString("en-US")}.${(c % 100n).toString().padStart(2, "0")}`;
};

const TTL_DAYS = 90;
/** A PROCESSING claim older than this is treated as abandoned (crashed invocation) and can be taken over. */
const CLAIM_LEASE_MS = 2 * 60 * 1000;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  configPromise ??= loadConfig();
  const cfg = await configPromise;
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await processRecord(record, cfg);
    } catch (err) {
      log("error", "record_failed", { messageId: record.messageId, receiveCount: record.attributes?.ApproximateReceiveCount, err: String(err) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

async function processRecord(record: SQSRecord, cfg: WorkerConfig) {
  const envelope = JSON.parse(record.body) as EventBridgeEnvelope;
  const type = envelope["detail-type"];
  const { eventId, tenantId, data } = envelope.detail;
  if (!eventId || !tenantId) throw new Error("Malformed event: missing eventId/tenantId");
  const table = process.env.NOTIFICATIONS_TABLE!;
  const key = { tenantId: { S: tenantId }, eventId: { S: eventId } };

  // 1. Claim. Succeeds for a new event, a previously FAILED one, or an abandoned (stale) claim.
  const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: table,
        Item: {
          ...key,
          type: { S: type },
          loanId: { S: data.loanId },
          status: { S: "PROCESSING" },
          receivedAt: { S: new Date().toISOString() },
          expiresAt: { N: String(Math.floor(Date.now() / 1000) + TTL_DAYS * 86400) },
        },
        ConditionExpression: "attribute_not_exists(eventId) OR #s = :failed OR (#s = :processing AND receivedAt < :stale)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":failed": { S: "FAILED" }, ":processing": { S: "PROCESSING" }, ":stale": { S: staleBefore } },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      const current = await ddb.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }));
      if (current.Item?.status?.S === "DONE") {
        log("info", "duplicate_skipped", { eventId, type });
        return; // already handled: acknowledge without side effects
      }
      // Another invocation holds a fresh claim: fail this record so SQS retries after the lease.
      throw new Error(`Event ${eventId} is being processed by another invocation`);
    }
    throw err;
  }

  // 2. Side effects.
  try {
    const effects: Record<string, string> = {};
    if (type === "loan.approved" || type === "loan.rejected") {
      const recipient = data.recipient as { email: string; fullName: string };
      const approved = type === "loan.approved";
      const amount = money(String(data.principalCents));
      const res = await ses.send(
        new SendEmailCommand({
          Source: cfg.sender,
          // SES sandbox only delivers to verified addresses; SES_REDIRECT_TO (e.g. the SES mailbox
          // simulator) receives the mail instead of the fictional customer address.
          Destination: { ToAddresses: [process.env.SES_REDIRECT_TO || recipient.email] },
          Message: {
            Subject: { Data: approved ? `Your loan of ${amount} is approved` : "Update on your loan application" },
            Body: {
              Text: {
                Data: approved
                  ? `Hi ${recipient.fullName},\n\nYour loan of ${amount} over ${data.termMonths} months has been approved. Your repayment schedule is available in your account.\n\n(Fictional demo message.)`
                  : `Hi ${recipient.fullName},\n\nWe're unable to approve your loan application at this time.\n\n(Fictional demo message.)`,
              },
            },
          },
        }),
      );
      effects.sesMessageId = res.MessageId ?? "";
      if (approved && BigInt(String(data.principalCents)) >= cfg.highValueThresholdCents) {
        const pub = await sns.send(
          new PublishCommand({
            TopicArn: process.env.OPS_TOPIC_ARN,
            Subject: "High-value loan approved",
            Message: JSON.stringify({ alert: "high_value_loan_approved", tenantId, loanId: data.loanId, principal: amount, eventId }),
            MessageAttributes: { severity: { DataType: "String", StringValue: "info" } },
          }),
        );
        effects.snsMessageId = pub.MessageId ?? "";
      }
    }

    // 3. Mark done.
    await ddb.send(
      new UpdateItemCommand({
        TableName: table,
        Key: key,
        UpdateExpression: "SET #s = :done, processedAt = :now, effects = :effects",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":done": { S: "DONE" }, ":now": { S: new Date().toISOString() }, ":effects": { S: JSON.stringify(effects) } },
      }),
    );
    log("info", "event_processed", { eventId, type, tenantId, ...effects });
  } catch (err) {
    await ddb
      .send(
        new UpdateItemCommand({
          TableName: table,
          Key: key,
          UpdateExpression: "SET #s = :failed, lastError = :e",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":failed": { S: "FAILED" }, ":e": { S: String(err).slice(0, 500) } },
        }),
      )
      .catch(() => undefined);
    throw err; // -> batchItemFailures -> SQS retry -> DLQ after 5 attempts
  }
}
