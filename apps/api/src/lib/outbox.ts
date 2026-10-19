import { randomUUID } from "node:crypto";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { Prisma } from "@prisma/client";
import { eventBridge } from "./aws";
import { config } from "./config";
import { prisma, type Tx } from "./db";
import { log } from "./log";

export const EVENT_SOURCE = "loan-app.api";
export type DomainEventType = "loan.created" | "loan.approved" | "loan.rejected" | "installment.paid" | "loan.closed";

/** Call INSIDE the business transaction: the event commits or rolls back with the state change. */
export function recordEvent(tx: Tx, tenantId: string, type: DomainEventType, data: Prisma.InputJsonObject) {
  return tx.outboxEvent.create({ data: { id: randomUUID(), tenantId, type, payload: data } });
}

interface OutboxRow { id: string; tenant_id: string; type: string; payload: unknown; created_at: Date }

/**
 * Relay one batch to EventBridge. FOR UPDATE SKIP LOCKED lets several API tasks run the
 * publisher concurrently without double-sending the same row. Delivery is at-least-once:
 * if we crash after PutEvents but before the UPDATE, the row is re-sent, so consumers
 * dedupe on eventId (the worker does, via a DynamoDB conditional write).
 */
export async function publishOutboxBatch(limit = 10): Promise<number> {
  if (!config.eventBusName) return 0;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT id, tenant_id, type, payload, created_at FROM outbox_events
      WHERE published_at IS NULL AND attempts < 10
      ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;

    const res = await eventBridge().send(
      new PutEventsCommand({
        Entries: rows.map((r) => ({
          EventBusName: config.eventBusName,
          Source: EVENT_SOURCE,
          DetailType: r.type,
          Detail: JSON.stringify({ eventId: r.id, tenantId: r.tenant_id, occurredAt: r.created_at.toISOString(), data: r.payload }),
        })),
      }),
    );
    // PutEvents is NOT all-or-nothing: check each entry.
    const results = res.Entries ?? [];
    for (const [i, row] of rows.entries()) {
      const failed = results[i]?.ErrorCode;
      if (failed) {
        await tx.$executeRaw`UPDATE outbox_events SET attempts = attempts + 1, last_error = ${`${failed}: ${results[i]?.ErrorMessage ?? ""}`} WHERE id = ${row.id}::uuid`;
      } else {
        await tx.$executeRaw`UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = ${row.id}::uuid`;
      }
    }
    log("info", "outbox_published", { count: rows.length, failed: res.FailedEntryCount ?? 0 });
    return rows.length;
  });
}

export function startOutboxPublisher(intervalMs = 1000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      while ((await publishOutboxBatch()) === 10); // drain bursts
    } catch (err) {
      log("error", "outbox_publish_failed", { err: String(err) });
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
