/**
 * Local stand-in for Lambda's SQS event source mapping: long-poll the queue, invoke the
 * SAME handler with a Lambda-shaped event, delete only the messages that succeeded.
 * Failed messages reappear after the visibility timeout; after 5 receives SQS moves them
 * to the DLQ (redrive policy in infra/local/messaging.tf).
 */
import { DeleteMessageBatchCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSEvent } from "aws-lambda";
import { handler } from "./handler";
import { log, startLogShipping } from "./log";

const queueUrl = process.env.EVENTS_QUEUE_URL!;
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
let running = true;

async function main() {
  const shipping = startLogShipping();
  log("info", "worker_started", { queueUrl });
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  while (running) {
    const res = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, MessageSystemAttributeNames: ["All"] }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) continue;

    const event: SQSEvent = {
      Records: messages.map((m) => ({
        messageId: m.MessageId!,
        receiptHandle: m.ReceiptHandle!,
        body: m.Body ?? "",
        attributes: (m.Attributes ?? {}) as SQSEvent["Records"][number]["attributes"],
        messageAttributes: {},
        md5OfBody: m.MD5OfBody ?? "",
        eventSource: "aws:sqs",
        eventSourceARN: queueUrl,
        awsRegion: process.env.AWS_REGION ?? "us-east-1",
      })),
    };
    const { batchItemFailures } = await handler(event);
    const failed = new Set(batchItemFailures.map((f) => f.itemIdentifier));
    const done = messages.filter((m) => !failed.has(m.MessageId!));
    if (done.length) {
      await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: done.map((m) => ({ Id: m.MessageId!, ReceiptHandle: m.ReceiptHandle! })) }));
    }
  }
  await shipping.stop();
  log("info", "worker_stopped");
}

main().catch((err) => {
  log("error", "worker_crashed", { err: String(err) });
  process.exit(1);
});
