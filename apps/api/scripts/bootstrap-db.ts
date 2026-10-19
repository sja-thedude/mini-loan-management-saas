/**
 * One-off task, run ONCE after RDS is created (as its own ECS task definition).
 * Connects as the RDS master user and creates the least-privilege `loan_app` role
 * and the `loans` database. The long-running app never receives master credentials.
 */
import { PrismaClient } from "@prisma/client";

const { DB_HOST, DB_MASTER_USER, DB_MASTER_PASSWORD, DB_PASSWORD } = process.env;

async function main() {
  if (!DB_HOST || !DB_MASTER_USER || !DB_MASTER_PASSWORD || !DB_PASSWORD) throw new Error("DB_HOST, DB_MASTER_USER, DB_MASTER_PASSWORD, DB_PASSWORD are required");
  // DDL cannot take bind parameters, so the password is validated before interpolation.
  if (!/^[A-Za-z0-9]{24,}$/.test(DB_PASSWORD)) throw new Error("DB_PASSWORD must be alphanumeric, 24+ chars");

  const enc = encodeURIComponent;
  const admin = new PrismaClient({ datasourceUrl: `postgresql://${enc(DB_MASTER_USER)}:${enc(DB_MASTER_PASSWORD)}@${DB_HOST}:5432/postgres?sslmode=require` });
  try {
    const [{ n }] = await admin.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'loan_app'`;
    const verb = n ? "ALTER" : "CREATE";
    await admin.$executeRawUnsafe(`${verb} ROLE loan_app LOGIN PASSWORD '${DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    // Needed so the master user may create a database owned by loan_app (PG 16+ rules).
    await admin.$executeRawUnsafe(`GRANT loan_app TO "${DB_MASTER_USER.replace(/"/g, "")}"`);
    const [{ d }] = await admin.$queryRaw<{ d: number }[]>`SELECT count(*)::int AS d FROM pg_database WHERE datname = 'loans'`;
    if (!d) await admin.$executeRawUnsafe(`CREATE DATABASE loans OWNER loan_app`);
    const role = await admin.$queryRaw`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'loan_app'`;
    console.log(JSON.stringify({ level: "info", msg: "db_bootstrap_done", role, roleAction: verb, databaseCreated: !d }));
  } finally {
    await admin.$disconnect();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ level: "error", msg: "db_bootstrap_failed", err: String(e) }));
  process.exit(1);
});
