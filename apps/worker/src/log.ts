import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

/**
 * JSON logs to stdout (on Lambda, stdout goes to CloudWatch Logs automatically). The local runner
 * also ships them to a CloudWatch Logs group in the emulator, the same place they'd land on AWS.
 */
type Level = "info" | "warn" | "error";
const buffer: { timestamp: number; message: string }[] = [];

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, service: "worker", ...fields });
  if (process.env.NODE_ENV !== "test") (level === "error" ? console.error : console.log)(line);
  if (process.env.LOG_GROUP) buffer.push({ timestamp: Date.now(), message: line });
}

export function startLogShipping(intervalMs = 2000) {
  const group = process.env.LOG_GROUP;
  if (!group) return { stop: async () => undefined };
  const client = new CloudWatchLogsClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  const stream = `local-runner/${new Date().toISOString().slice(0, 10)}/${process.pid}`;
  const ready = client.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: stream })).catch(() => undefined);
  const flush = async () => {
    if (buffer.length === 0) return;
    await ready;
    const events = buffer.splice(0, buffer.length);
    await client.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: stream, logEvents: events })).catch(() => undefined);
  };
  const timer = setInterval(flush, intervalMs);
  return { stop: async () => { clearInterval(timer); await flush(); } };
}
