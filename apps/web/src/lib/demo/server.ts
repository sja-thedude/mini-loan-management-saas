/**
 * In-browser mock of the Express API, used by the static S3 + CloudFront demo.
 * Same routes, same validation rules, same response shapes, and the same tenant rule:
 * every read and write goes through `scoped()`, which only ever sees the session's tenant
 * (the browser-side stand-in for Postgres row-level security).
 *
 * Data lives in this browser's localStorage, so each visitor gets their own sandbox.
 */
import { buildSchedule, formatCents, parseAmountToCents, parsePercentToBps } from "../money";
import { DEMO_PASSWORD, buildSeed, hashPassword } from "./seed";
import { type DemoDb, DemoHttpError, type DemoSession } from "./types";

const DB_KEY = "mlm-demo-db-v1";
const SESSION_KEY = "mlm-demo-session-v1";

let cache: DemoDb | null = null;

function storageGet(store: Storage | undefined, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}
function storageSet(store: Storage | undefined, key: string, value: string | null) {
  try { if (value === null) store?.removeItem(key); else store?.setItem(key, value); } catch { /* private mode: in-memory only */ }
}
const local = () => (typeof window === "undefined" ? undefined : window.localStorage);
const session = () => (typeof window === "undefined" ? undefined : window.sessionStorage);

async function db(): Promise<DemoDb> {
  if (cache) return cache;
  const raw = storageGet(local(), DB_KEY);
  if (raw) {
    try { cache = JSON.parse(raw) as DemoDb; return cache; } catch { /* corrupted: reseed */ }
  }
  cache = await buildSeed();
  save();
  return cache;
}
function save() { if (cache) storageSet(local(), DB_KEY, JSON.stringify(cache)); }

export async function resetDemoData() {
  cache = null;
  storageSet(local(), DB_KEY, null);
  await db();
}

// ---------- helpers ----------
const err = (status: number, message: string) => new DemoHttpError(status, message);
const invalid = (issues: { path: string; message: string }[]) => new DemoHttpError(400, issues.map((i) => `${i.path}: ${i.message}`).join("; "), issues);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;
const PERCENT = /^\d{1,2}(\.\d{1,2})?$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

function requireSession(): DemoSession {
  const raw = storageGet(session(), SESSION_KEY);
  if (!raw) throw err(401, "Authentication required");
  return JSON.parse(raw) as DemoSession;
}
const requireAdmin = (s: DemoSession) => { if (s.role !== "ADMIN") throw err(403, "You do not have permission for this action"); };
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The ONLY way handlers reach tenant data: rows outside the session tenant are invisible. */
function scoped<K extends "users" | "customers" | "loans" | "installments" | "auditLogs">(d: DemoDb, table: K, s: DemoSession): DemoDb[K] {
  return (d[table] as { tenantId: string }[]).filter((row) => row.tenantId === s.tenantId) as DemoDb[K];
}

function audit(d: DemoDb, s: DemoSession, action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>) {
  d.auditLogs.push({ id: id(), tenantId: s.tenantId, userId: s.userId, action, entityType, entityId, metadata: metadata ?? null, createdAt: now() });
}

const serializeSchedule = (rows: ReturnType<typeof buildSchedule>) =>
  rows.map((r) => ({ number: r.number, dueDate: r.dueDate.toISOString(), principalCents: String(r.principalCents), interestCents: String(r.interestCents), totalCents: String(r.totalCents), balanceAfterCents: String(r.balanceAfterCents) }));

// ---------- routes ----------
type Body = Record<string, unknown>;
type Handler = (ctx: { d: DemoDb; params: string[]; query: URLSearchParams; body: Body }) => Promise<unknown> | unknown;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), h]);

route("POST", "/auth/login", async ({ d, body }) => {
  const slug = str(body.companySlug).toLowerCase();
  const email = str(body.email).toLowerCase();
  const tenant = d.tenants.find((t) => t.slug === slug);
  const user = tenant && d.users.find((u) => u.tenantId === tenant.id && u.email === email);
  const ok = user && (await hashPassword(String(body.password ?? ""), user.salt)) === user.passwordHash;
  if (!tenant || !user || !ok) throw err(401, "Invalid company, email or password");
  const s: DemoSession = { userId: user.id, tenantId: tenant.id, role: user.role };
  storageSet(session(), SESSION_KEY, JSON.stringify(s));
  audit(d, s, "user.login", "user", user.id);
  return { user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } };
});

route("POST", "/auth/register", async ({ d, body }) => {
  const companyName = str(body.companyName), companySlug = str(body.companySlug).toLowerCase(), fullName = str(body.fullName), email = str(body.email).toLowerCase();
  const password = String(body.password ?? "");
  const issues = [
    ...(companyName.length < 2 ? [{ path: "companyName", message: "Too short" }] : []),
    ...(!SLUG.test(companySlug) ? [{ path: "companySlug", message: "3-40 chars: a-z, 0-9, hyphen" }] : []),
    ...(fullName.length < 2 ? [{ path: "fullName", message: "Too short" }] : []),
    ...(!EMAIL.test(email) ? [{ path: "email", message: "Invalid email" }] : []),
    ...(password.length < 10 ? [{ path: "password", message: "At least 10 characters" }] : []),
  ];
  if (issues.length) throw invalid(issues);
  if (d.tenants.some((t) => t.slug === companySlug)) throw err(409, "Company slug is taken");
  const tenantId = id(), userId = id();
  d.tenants.push({ id: tenantId, name: companyName, slug: companySlug, createdAt: now() });
  d.users.push({ id: userId, tenantId, email, fullName, role: "ADMIN", salt: userId, passwordHash: await hashPassword(password, userId), createdAt: now() });
  const s: DemoSession = { userId, tenantId, role: "ADMIN" };
  storageSet(session(), SESSION_KEY, JSON.stringify(s));
  audit(d, s, "tenant.created", "tenant", tenantId);
  return { user: { id: userId, email, fullName, role: "ADMIN" } };
});

route("POST", "/auth/logout", () => { storageSet(session(), SESSION_KEY, null); return undefined; });

route("GET", "/auth/me", ({ d }) => {
  const s = requireSession();
  const user = scoped(d, "users", s).find((u) => u.id === s.userId);
  const tenant = d.tenants.find((t) => t.id === s.tenantId);
  if (!user || !tenant) throw err(401, "Session user no longer exists");
  return { user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role }, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } };
});

route("GET", "/dashboard", ({ d }) => {
  const s = requireSession();
  const loans = scoped(d, "loans", s);
  const due = scoped(d, "installments", s).filter((i) => i.status === "DUE");
  const statuses = ["PENDING", "APPROVED", "REJECTED", "CLOSED"] as const;
  const customers = scoped(d, "customers", s);
  return {
    customers: customers.length,
    byStatus: statuses
      .map((st) => {
        const ls = loans.filter((l) => l.status === st);
        return { status: st, count: ls.length, principalCents: String(ls.reduce((a, l) => a + BigInt(l.principalCents), 0n)) };
      })
      .filter((b) => b.count > 0),
    outstandingPrincipalCents: String(due.reduce((a, i) => a + BigInt(i.principalCents), 0n)),
    outstandingInterestCents: String(due.reduce((a, i) => a + BigInt(i.interestCents), 0n)),
    overdueInstallments: due.filter((i) => i.dueDate < now()).length,
    recentLoans: [...loans]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
      .map((l) => ({ ...l, customer: { fullName: customers.find((c) => c.id === l.customerId)?.fullName ?? "" } })),
  };
});

route("GET", "/customers", ({ d, query }) => {
  const s = requireSession();
  const q = (query.get("q") ?? "").toLowerCase();
  const loans = scoped(d, "loans", s);
  return scoped(d, "customers", s)
    .filter((c) => !q || c.fullName.toLowerCase().includes(q) || c.email.includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({ ...c, _count: { loans: loans.filter((l) => l.customerId === c.id).length } }));
});

route("POST", "/customers", ({ d, body }) => {
  const s = requireSession();
  const fullName = str(body.fullName), email = str(body.email).toLowerCase(), phone = str(body.phone), income = str(body.monthlyIncome);
  const issues = [
    ...(fullName.length < 2 || fullName.length > 100 ? [{ path: "fullName", message: "2-100 characters" }] : []),
    ...(!EMAIL.test(email) ? [{ path: "email", message: "Invalid email" }] : []),
    ...(!AMOUNT.test(income) ? [{ path: "monthlyIncome", message: "Amount like 1234.56" }] : []),
  ];
  if (issues.length) throw invalid(issues);
  if (scoped(d, "customers", s).some((c) => c.email === email)) throw err(409, "A record with these details already exists");
  const c = { id: id(), tenantId: s.tenantId, fullName, email, phone: phone || null, monthlyIncomeCents: String(parseAmountToCents(income)), createdAt: now() };
  d.customers.push(c);
  audit(d, s, "customer.created", "customer", c.id);
  return c;
});

route("GET", "/loans", ({ d, query }) => {
  const s = requireSession();
  const status = query.get("status");
  const customers = scoped(d, "customers", s);
  return scoped(d, "loans", s)
    .filter((l) => !status || l.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((l) => {
      const c = customers.find((x) => x.id === l.customerId)!;
      return { ...l, customer: { id: c.id, fullName: c.fullName } };
    });
});

route("POST", "/loans", ({ d, body }) => {
  const s = requireSession();
  const principal = str(body.principal), rate = str(body.annualRatePercent), purpose = str(body.purpose), customerId = str(body.customerId);
  const term = body.termMonths;
  const issues = [
    ...(!UUID.test(customerId) ? [{ path: "customerId", message: "Invalid UUID" }] : []),
    ...(!AMOUNT.test(principal) ? [{ path: "principal", message: "Amount like 15000.00" }] : []),
    ...(!PERCENT.test(rate) ? [{ path: "annualRatePercent", message: "Percentage like 12.5" }] : []),
    ...(typeof term !== "number" || !Number.isInteger(term) || term < 1 || term > 360 ? [{ path: "termMonths", message: "Whole months, 1-360" }] : []),
    ...(purpose.length < 3 || purpose.length > 200 ? [{ path: "purpose", message: "3-200 characters" }] : []),
  ];
  if (issues.length) throw invalid(issues);
  const cents = parseAmountToCents(principal);
  if (cents < 100_00n || cents > 10_000_000_00n) throw invalid([{ path: "principal", message: "Principal must be between 100.00 and 10,000,000.00" }]);
  const customer = scoped(d, "customers", s).find((c) => c.id === customerId);
  if (!customer) throw err(404, "Customer not found");
  const loan = {
    id: id(), tenantId: s.tenantId, customerId, principalCents: String(cents), annualRateBps: parsePercentToBps(rate), termMonths: term as number,
    purpose, status: "PENDING" as const, createdById: s.userId, decidedById: null, decidedAt: null, decisionNote: null, createdAt: now(), updatedAt: now(),
  };
  d.loans.push(loan);
  audit(d, s, "loan.created", "loan", loan.id, { principal: formatCents(cents), rateBps: loan.annualRateBps, termMonths: loan.termMonths });
  return loan;
});

function findLoan(d: DemoDb, s: DemoSession, loanId: string) {
  if (!UUID.test(loanId)) throw invalid([{ path: "id", message: "Invalid UUID" }]);
  const loan = scoped(d, "loans", s).find((l) => l.id === loanId);
  if (!loan) throw err(404, "Loan not found"); // 404 (not 403) for other tenants' ids
  return loan;
}

route("GET", "/loans/:id", ({ d, params }) => {
  const s = requireSession();
  const loan = findLoan(d, s, params[0]);
  return {
    ...loan,
    customer: scoped(d, "customers", s).find((c) => c.id === loan.customerId),
    installments: scoped(d, "installments", s).filter((i) => i.loanId === loan.id).sort((a, b) => a.number - b.number),
    documents: [],
    projectedSchedule: loan.status === "PENDING" ? serializeSchedule(buildSchedule(BigInt(loan.principalCents), loan.annualRateBps, loan.termMonths, new Date())) : null,
  };
});

for (const [verb, to] of [["approve", "APPROVED"], ["reject", "REJECTED"]] as const) {
  route("POST", `/loans/:id/${verb}`, ({ d, params, body }) => {
    const s = requireSession();
    requireAdmin(s);
    const loan = findLoan(d, s, params[0]);
    if (loan.status !== "PENDING") throw err(409, `Loan is already ${loan.status}`);
    const note = str(body.note).slice(0, 500) || null;
    Object.assign(loan, { status: to, decidedById: s.userId, decidedAt: now(), decisionNote: note, updatedAt: now() });
    if (to === "APPROVED") {
      for (const r of buildSchedule(BigInt(loan.principalCents), loan.annualRateBps, loan.termMonths, new Date())) {
        d.installments.push({
          id: id(), tenantId: s.tenantId, loanId: loan.id, number: r.number, dueDate: r.dueDate.toISOString(),
          principalCents: String(r.principalCents), interestCents: String(r.interestCents), totalCents: String(r.totalCents), status: "DUE", paidAt: null,
        });
      }
    }
    audit(d, s, `loan.${to.toLowerCase()}`, "loan", loan.id, note ? { note } : undefined);
    return loan;
  });
}

route("POST", "/loans/:id/installments/:number/pay", ({ d, params }) => {
  const s = requireSession();
  const loan = findLoan(d, s, params[0]);
  if (loan.status !== "APPROVED") throw err(409, `Cannot record payments on a ${loan.status} loan`);
  const mine = scoped(d, "installments", s).filter((i) => i.loanId === loan.id);
  const inst = mine.find((i) => i.number === Number(params[1]) && i.status === "DUE");
  if (!inst) throw err(409, "Installment not found or already paid");
  Object.assign(inst, { status: "PAID", paidAt: now() });
  const remaining = mine.filter((i) => i.status === "DUE").length;
  if (remaining === 0) Object.assign(loan, { status: "CLOSED", updatedAt: now() });
  audit(d, s, "installment.paid", "loan", loan.id, { number: inst.number });
  return { loanStatus: loan.status, remaining };
});

route("POST", "/loans/:id/documents", () => {
  requireSession();
  throw err(503, "Document uploads use S3 presigned POST signed by the API. They are disabled in this static demo; see the full ECS deployment design.");
});

route("GET", "/audit-logs", ({ d }) => {
  const s = requireSession();
  requireAdmin(s);
  return [...scoped(d, "auditLogs", s)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
});

route("GET", "/health", () => ({ status: "ok", mode: "static-demo" }));

/** Entry point used by lib/api.ts when NEXT_PUBLIC_DEMO_MODE=true. */
export async function demoRequest(path: string, method: string, body: unknown): Promise<unknown> {
  const d = await db();
  const [pathname, qs = ""] = path.split("?");
  for (const [m, re, h] of routes) {
    const match = m === method && re.exec(pathname);
    if (match) {
      const result = await h({ d, params: match.slice(1), query: new URLSearchParams(qs), body: (body ?? {}) as Body });
      if (method !== "GET") save();
      // Round-trip through JSON so callers get exactly what a network response would give them.
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    }
  }
  throw err(404, "Route not found");
}

export { DEMO_PASSWORD };
