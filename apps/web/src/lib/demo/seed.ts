// Deterministic fictional demo data: same companies, people and loans on every fresh load.
import { buildSchedule } from "../money";
import type { DemoDb, DemoInstallment, DemoLoan } from "./types";

/** Small seeded PRNG (mulberry32) so the demo is reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ava", "Ben", "Cara", "Dan", "Eve", "Finn", "Gia", "Hugo", "Iris", "Jon", "Kira", "Leo", "Mila", "Nate", "Opal", "Paz", "Quinn", "Rhea", "Sami", "Tess"];
const LAST = ["Fictional", "Sample", "Demo", "Placeholder", "Testcase", "Mockridge", "Stubbs", "Fakely", "Dummond", "Exampleton"];
const PURPOSES = ["Delivery van", "Shop renovation", "Working capital", "Restaurant equipment", "Inventory financing", "Solar installation", "Medical practice fit-out", "Fleet expansion", "Bakery ovens", "POS & IT upgrade"];
const TERMS = [6, 12, 18, 24, 36, 48, 60];

export const DEMO_PASSWORD = "DemoPassword123!";

export async function hashPassword(password: string, salt: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${password}`));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

const uuid = (r: () => number) =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const v = Math.floor(r() * 16);
    return (c === "x" ? v : (v & 0x3) | 0x8).toString(16);
  });

const DAY = 86_400_000;

export async function buildSeed(now = new Date()): Promise<DemoDb> {
  const r = rng(20261021);
  const db: DemoDb = { version: 1, tenants: [], users: [], customers: [], loans: [], installments: [], documents: [], auditLogs: [] };
  const companies = [
    { name: "Acme Lending", slug: "acme", customers: 14 },
    { name: "Bluebird Finance", slug: "bluebird", customers: 9 },
  ];

  for (const co of companies) {
    const tenantId = uuid(r);
    db.tenants.push({ id: tenantId, name: co.name, slug: co.slug, createdAt: new Date(now.getTime() - 300 * DAY).toISOString() });
    const users = [
      { role: "ADMIN" as const, email: `admin@${co.slug}.example`, fullName: `${co.name.split(" ")[0]} Admin` },
      { role: "OFFICER" as const, email: `officer@${co.slug}.example`, fullName: `${co.name.split(" ")[0]} Officer` },
    ];
    const userIds: string[] = [];
    for (const u of users) {
      const id = uuid(r);
      userIds.push(id);
      db.users.push({ id, tenantId, ...u, salt: id, passwordHash: await hashPassword(DEMO_PASSWORD, id), createdAt: db.tenants.at(-1)!.createdAt });
    }
    const [adminId, officerId] = userIds;
    const log = (at: Date, userId: string, action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>) =>
      db.auditLogs.push({ id: uuid(r), tenantId, userId, action, entityType, entityId, metadata: metadata ?? null, createdAt: at.toISOString() });

    for (let i = 0; i < co.customers; i++) {
      const fullName = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
      const createdAt = new Date(now.getTime() - Math.floor(30 + r() * 240) * DAY);
      const customerId = uuid(r);
      db.customers.push({
        id: customerId, tenantId, fullName,
        email: `${fullName.toLowerCase().replace(/[^a-z]+/g, ".")}.${i}@${co.slug}-customers.example`,
        phone: `+1-555-01${String(10 + i).padStart(2, "0")}`,
        monthlyIncomeCents: String(BigInt(2_500 + Math.floor(r() * 12_000)) * 100n),
        createdAt: createdAt.toISOString(),
      });
      log(createdAt, officerId, "customer.created", "customer", customerId);

      const loanCount = r() < 0.35 ? 2 : 1;
      for (let k = 0; k < loanCount; k++) {
        const appliedAt = new Date(createdAt.getTime() + Math.floor(1 + r() * 20) * DAY);
        const principal = BigInt(2_000 + Math.floor(r() * 146) * 500) * 100n;
        const rateBps = 650 + Math.floor(r() * 37) * 50;
        const term = TERMS[Math.floor(r() * TERMS.length)];
        const roll = r();
        const status: DemoLoan["status"] = roll < 0.52 ? "APPROVED" : roll < 0.72 ? "PENDING" : roll < 0.87 ? "REJECTED" : "CLOSED";
        const loanId = uuid(r);
        const decidedAt = status === "PENDING" ? null : new Date(appliedAt.getTime() + Math.floor(1 + r() * 5) * DAY);
        const loan: DemoLoan = {
          id: loanId, tenantId, customerId, principalCents: String(principal), annualRateBps: rateBps, termMonths: term,
          purpose: PURPOSES[Math.floor(r() * PURPOSES.length)], status, createdById: officerId,
          decidedById: decidedAt ? adminId : null, decidedAt: decidedAt?.toISOString() ?? null,
          decisionNote: status === "REJECTED" ? "Debt-to-income ratio above policy limit" : status === "PENDING" ? null : "Meets credit policy",
          createdAt: appliedAt.toISOString(), updatedAt: (decidedAt ?? appliedAt).toISOString(),
        };
        db.loans.push(loan);
        log(appliedAt, officerId, "loan.created", "loan", loanId, { principal: `${principal / 100n}.00`, rateBps, termMonths: term });
        if (decidedAt) log(decidedAt, adminId, status === "REJECTED" ? "loan.rejected" : "loan.approved", "loan", loanId);

        if (status === "APPROVED" || status === "CLOSED") {
          const behind = status === "APPROVED" && r() < 0.25; // some borrowers fall behind -> overdue installments
          for (const row of buildSchedule(principal, rateBps, term, decidedAt!)) {
            const due = row.dueDate.getTime() < now.getTime();
            const paid = status === "CLOSED" || (due && !(behind && row.dueDate.getTime() > now.getTime() - 75 * DAY));
            const inst: DemoInstallment = {
              id: uuid(r), tenantId, loanId, number: row.number, dueDate: row.dueDate.toISOString(),
              principalCents: String(row.principalCents), interestCents: String(row.interestCents), totalCents: String(row.totalCents),
              status: paid ? "PAID" : "DUE", paidAt: paid ? new Date(Math.min(row.dueDate.getTime(), now.getTime())).toISOString() : null,
            };
            db.installments.push(inst);
          }
          if (status === "CLOSED") log(now, officerId, "installment.paid", "loan", loanId, { number: term, note: "early payoff" });
        }
      }
    }
  }
  db.auditLogs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return db;
}
