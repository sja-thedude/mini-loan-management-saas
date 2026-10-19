import { Prisma, PrismaClient } from "@prisma/client";

// On AWS, ECS injects DB_PASSWORD from Secrets Manager; the URL is assembled in memory.
if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const { DB_HOST, DB_USER = "loan_app", DB_PASSWORD = "", DB_NAME = "loans" } = process.env;
  process.env.DATABASE_URL = `postgresql://${DB_USER}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:5432/${DB_NAME}?sslmode=require`;
}

export const prisma = new PrismaClient();

export type Tx = Prisma.TransactionClient;

/**
 * Run `fn` inside a transaction whose Postgres session has app.tenant_id set.
 * set_config(..., true) is transaction-local, so the value cannot leak to another
 * request that later reuses the same pooled connection.
 *
 * This is the DATABASE layer of tenant isolation (RLS). Route handlers ALSO filter
 * by tenantId explicitly: the API layer. Either layer alone would stop a cross-tenant
 * read; together, a bug in one is caught by the other.
 */
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
