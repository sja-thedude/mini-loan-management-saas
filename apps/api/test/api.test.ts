import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma, withTenant } from "../src/lib/db";

const app = createApp();
const PASSWORD = "CorrectHorse123!";

async function registerCompany(slug: string) {
  const res = await request(app).post("/api/auth/register").send({
    companyName: `${slug} Lending`, companySlug: slug, fullName: `${slug} Admin`, email: `admin@${slug}.test`, password: PASSWORD,
  });
  expect(res.status).toBe(201);
  const login = await request(app).post("/api/auth/login").send({ companySlug: slug, email: `admin@${slug}.test`, password: PASSWORD });
  expect(login.status).toBe(200);
  return { token: login.body.token as string, cookie: login.headers["set-cookie"] as unknown as string[] };
}

let A: { token: string }, B: { token: string };
let aCustomerId: string, aLoanId: string, bCustomerId: string, bLoanId: string;
const as = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE tenants, users, customers, loans, installments, documents, audit_logs, outbox_events, idempotency_keys CASCADE`);
  A = await registerCompany("company-a");
  B = await registerCompany("company-b");

  const mk = async (t: { token: string }, email: string) => {
    const c = await request(app).post("/api/customers").set(as(t)).send({ fullName: "Test Person", email, monthlyIncome: "5000.00" });
    expect(c.status).toBe(201);
    const l = await request(app).post("/api/loans").set(as(t)).send({ customerId: c.body.id, principal: "12000.00", annualRatePercent: "10", termMonths: 12, purpose: "Fictional equipment" });
    expect(l.status).toBe(201);
    return [c.body.id, l.body.id];
  };
  [aCustomerId, aLoanId] = await mk(A, "a@example.test");
  [bCustomerId, bLoanId] = await mk(B, "b@example.test");
});

afterAll(() => prisma.$disconnect());

describe("authentication", () => {
  it("rejects requests without a session", async () => {
    expect((await request(app).get("/api/loans")).status).toBe(401);
  });
  it("rejects a forged token", async () => {
    const res = await request(app).get("/api/loans").set("Authorization", "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.");
    expect(res.status).toBe(401);
  });
  it("rejects a wrong password with a generic message", async () => {
    const res = await request(app).post("/api/auth/login").send({ companySlug: "company-a", email: "admin@company-a.test", password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid company, email or password");
  });
  it("sets an httpOnly session cookie on login", async () => {
    const res = await request(app).post("/api/auth/login").send({ companySlug: "company-a", email: "admin@company-a.test", password: PASSWORD });
    expect(String(res.headers["set-cookie"])).toMatch(/session=.*HttpOnly/i);
  });
  it("OFFICER cannot approve loans", async () => {
    const created = await request(app).post("/api/users").set(as(A)).send({ fullName: "Officer One", email: "officer@company-a.test", password: PASSWORD, role: "OFFICER" });
    expect(created.status).toBe(201);
    const login = await request(app).post("/api/auth/login").send({ companySlug: "company-a", email: "officer@company-a.test", password: PASSWORD });
    const res = await request(app).post(`/api/loans/${aLoanId}/approve`).set("Authorization", `Bearer ${login.body.token}`).send({});
    expect(res.status).toBe(403);
  });
});

describe("tenant isolation (API layer)", () => {
  it("Company A's loan list contains only its own loans", async () => {
    const res = await request(app).get("/api/loans").set(as(A));
    expect(res.body.map((l: { id: string }) => l.id)).toEqual([aLoanId]);
  });
  it("Company A gets 404 (not 403) reading Company B's loan and customer", async () => {
    expect((await request(app).get(`/api/loans/${bLoanId}`).set(as(A))).status).toBe(404);
    expect((await request(app).get(`/api/customers/${bCustomerId}`).set(as(A))).status).toBe(404);
  });
  it("Company A cannot approve, reject or pay Company B's loan", async () => {
    expect((await request(app).post(`/api/loans/${bLoanId}/approve`).set(as(A)).send({})).status).toBe(404);
    expect((await request(app).post(`/api/loans/${bLoanId}/reject`).set(as(A)).send({})).status).toBe(404);
    expect((await request(app).post(`/api/loans/${bLoanId}/installments/1/pay`).set(as(A))).status).toBe(404);
    const b = await request(app).get(`/api/loans/${bLoanId}`).set(as(B));
    expect(b.body.status).toBe("PENDING");
  });
  it("Company A cannot create a loan for Company B's customer", async () => {
    const res = await request(app).post("/api/loans").set(as(A)).send({ customerId: bCustomerId, principal: "1000.00", annualRatePercent: "5", termMonths: 6, purpose: "Cross-tenant attempt" });
    expect(res.status).toBe(404);
  });
  it("dashboard and audit logs only count own data", async () => {
    const dash = await request(app).get("/api/dashboard").set(as(A));
    expect(dash.body.customers).toBe(1);
    const logs = await request(app).get("/api/audit-logs").set(as(A));
    const tenantIds = new Set(logs.body.map((l: { tenantId: string }) => l.tenantId));
    expect(tenantIds.size).toBe(1);
  });
});

describe("tenant isolation (database layer: row-level security)", () => {
  const tenantOf = async (slug: string) => (await prisma.tenant.findUniqueOrThrow({ where: { slug } })).id;

  it("a query with NO tenant filter still only returns the current tenant's rows", async () => {
    const aId = await tenantOf("company-a");
    const loans = await withTenant(aId, (tx) => tx.loan.findMany()); // deliberately unfiltered
    expect(loans.map((l) => l.id)).toEqual([aLoanId]);
  });
  it("with no tenant context set, zero rows are visible (fails closed)", async () => {
    expect(await prisma.loan.count()).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
  });
  it("cannot insert a row for another tenant while in tenant A's context", async () => {
    const aId = await tenantOf("company-a");
    const bId = await tenantOf("company-b");
    await expect(
      withTenant(aId, (tx) => tx.customer.create({ data: { tenantId: bId, fullName: "Evil", email: "evil@x.test", monthlyIncomeCents: 1n } })),
    ).rejects.toThrow(/row-level security/);
  });
  it("audit log is append-only", async () => {
    const aId = await tenantOf("company-a");
    const n = await withTenant(aId, (tx) => tx.auditLog.deleteMany({}));
    expect(n.count).toBe(0);
  });
});

describe("loan lifecycle", () => {
  it("approve creates a schedule summing to the principal; second approve is 409", async () => {
    const res = await request(app).post(`/api/loans/${aLoanId}/approve`).set(as(A)).send({ note: "Looks good" });
    expect(res.status).toBe(200);
    const loan = (await request(app).get(`/api/loans/${aLoanId}`).set(as(A))).body;
    expect(loan.status).toBe("APPROVED");
    expect(loan.installments).toHaveLength(12);
    const sum = loan.installments.reduce((s: bigint, i: { principalCents: string }) => s + BigInt(i.principalCents), 0n);
    expect(sum).toBe(1_200_000n);
    expect(typeof loan.principalCents).toBe("string");
    expect((await request(app).post(`/api/loans/${aLoanId}/approve`).set(as(A)).send({})).status).toBe(409);
  });
  it("paying all installments closes the loan", async () => {
    for (let n = 1; n <= 12; n++) {
      expect((await request(app).post(`/api/loans/${aLoanId}/installments/${n}/pay`).set(as(A))).status).toBe(200);
    }
    expect((await request(app).get(`/api/loans/${aLoanId}`).set(as(A))).body.status).toBe("CLOSED");
    expect((await request(app).post(`/api/loans/${aLoanId}/installments/1/pay`).set(as(A))).status).toBe(409);
  });
  it("rejected loans cannot take payments", async () => {
    await request(app).post(`/api/loans/${bLoanId}/reject`).set(as(B)).send({ note: "Insufficient income" });
    expect((await request(app).post(`/api/loans/${bLoanId}/installments/1/pay`).set(as(B))).status).toBe(409);
  });
});

describe("input validation & error handling", () => {
  it("rejects float-style or negative money", async () => {
    for (const principal of ["12.345", "-100", "1e6", 1000]) {
      const res = await request(app).post("/api/loans").set(as(A)).send({ customerId: aCustomerId, principal, annualRatePercent: "5", termMonths: 12, purpose: "Test" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_error");
    }
  });
  it("rejects malformed ids and JSON", async () => {
    expect((await request(app).get("/api/loans/not-a-uuid").set(as(A))).status).toBe(400);
    const bad = await request(app).post("/api/customers").set(as(A)).set("Content-Type", "application/json").send("{bad");
    expect(bad.status).toBe(400);
  });
  it("disallowed file types are rejected", async () => {
    const res = await request(app).post(`/api/loans/${aLoanId}/documents`).set(as(A)).send({ fileName: "x.exe", contentType: "application/x-msdownload" });
    expect(res.status).toBe(400);
  });
});
