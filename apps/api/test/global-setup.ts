import { execSync } from "node:child_process";

export default function setup() {
  const url = "postgresql://loan_app:loan_app_local_only@localhost:5433/loans_test";
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
