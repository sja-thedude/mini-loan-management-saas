import type { Prisma } from "@prisma/client";
import type { Tx } from "./db";

/** Written in the SAME transaction as the change it describes: both commit or neither. */
export function audit(
  tx: Tx,
  e: { tenantId: string; userId?: string; action: string; entityType: string; entityId: string; metadata?: Prisma.InputJsonValue },
) {
  return tx.auditLog.create({ data: e });
}
