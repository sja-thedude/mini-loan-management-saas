import { beforeAll, describe, expect, it } from "vitest";

// Minimal browser storage stand-ins so the mock API runs under Node.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
(globalThis as unknown as { window: unknown }).window = { localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() };

const { demoRequest } = await import("../src/lib/demo/server");
type Loan = { id: string; tenantId: string; status: string; principalCents: string };

const login = (slug: string, who = "admin") =>
  demoRequest("/auth/login", "POST", { companySlug: slug, email: `${who}@${slug}.example`, password: "DemoPassword123!" });

let bluebirdLoans: Loan[] = [];
beforeAll(async () => {
  await login("bluebird");
  bluebirdLoans = (await demoRequest("/loans", "GET", undefined)) as Loan[];
});

describe("static demo mock API", () => {
  it("seeds realistic data for both tenants", async () => {
    expect(bluebirdLoans.length).toBeGreaterThan(5);
    await login("acme");
    const dash = (await demoRequest("/dashboard", "GET", undefined)) as { customers: number; byStatus: unknown[] };
    expect(dash.customers).toBe(14);
    expect(dash.byStatus.length).toBeGreaterThanOrEqual(3);
  });

  it("enforces tenant isolation: Acme cannot see or act on Bluebird loans", async () => {
    await login("acme");
    const acmeLoans = (await demoRequest("/loans", "GET", undefined)) as Loan[];
    const acmeTenant = acmeLoans[0].tenantId;
    expect(acmeLoans.every((l) => l.tenantId === acmeTenant)).toBe(true);
    const target = bluebirdLoans.find((l) => l.status === "PENDING") ?? bluebirdLoans[0];
    await expect(demoRequest(`/loans/${target.id}`, "GET", undefined)).rejects.toMatchObject({ status: 404 });
    await expect(demoRequest(`/loans/${target.id}/approve`, "POST", {})).rejects.toMatchObject({ status: 404 });
  });

  it("officers cannot approve; admins can, and the schedule sums to the principal", async () => {
    await login("acme", "officer");
    const pending = ((await demoRequest("/loans?status=PENDING", "GET", undefined)) as Loan[])[0];
    await expect(demoRequest(`/loans/${pending.id}/approve`, "POST", {})).rejects.toMatchObject({ status: 403 });
    await login("acme", "admin");
    await demoRequest(`/loans/${pending.id}/approve`, "POST", { note: "ok" });
    const detail = (await demoRequest(`/loans/${pending.id}`, "GET", undefined)) as { status: string; installments: { principalCents: string }[] };
    expect(detail.status).toBe("APPROVED");
    expect(detail.installments.reduce((s, i) => s + BigInt(i.principalCents), 0n)).toBe(BigInt(pending.principalCents));
    await expect(demoRequest(`/loans/${pending.id}/approve`, "POST", {})).rejects.toMatchObject({ status: 409 });
  });

  it("validates money input like the real API", async () => {
    await login("acme");
    const c = ((await demoRequest("/customers", "GET", undefined)) as { id: string }[])[0];
    for (const principal of ["12.345", "-5", "1e6"]) {
      await expect(demoRequest("/loans", "POST", { customerId: c.id, principal, annualRatePercent: "5", termMonths: 12, purpose: "Test" })).rejects.toMatchObject({ status: 400 });
    }
  });

  it("rejects bad credentials and unauthenticated calls", async () => {
    await expect(demoRequest("/auth/login", "POST", { companySlug: "acme", email: "admin@acme.example", password: "nope" })).rejects.toMatchObject({ status: 401 });
    await demoRequest("/auth/logout", "POST", undefined);
    await expect(demoRequest("/loans", "GET", undefined)).rejects.toMatchObject({ status: 401 });
  });
});
