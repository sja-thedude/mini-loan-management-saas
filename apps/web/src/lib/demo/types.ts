// Mirrors the Prisma models. Money is integer cents as strings (same wire format as the real API).
export type Role = "ADMIN" | "OFFICER";

export interface DemoTenant { id: string; name: string; slug: string; createdAt: string }
export interface DemoUser { id: string; tenantId: string; email: string; fullName: string; role: Role; salt: string; passwordHash: string; createdAt: string }
export interface DemoCustomer { id: string; tenantId: string; fullName: string; email: string; phone: string | null; monthlyIncomeCents: string; createdAt: string }
export interface DemoLoan {
  id: string; tenantId: string; customerId: string; principalCents: string; annualRateBps: number; termMonths: number; purpose: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CLOSED"; createdById: string; decidedById: string | null; decidedAt: string | null;
  decisionNote: string | null; createdAt: string; updatedAt: string;
}
export interface DemoInstallment {
  id: string; tenantId: string; loanId: string; number: number; dueDate: string;
  principalCents: string; interestCents: string; totalCents: string; status: "DUE" | "PAID"; paidAt: string | null;
}
export interface DemoAuditLog { id: string; tenantId: string; userId: string | null; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> | null; createdAt: string }

export interface DemoDb {
  version: 1;
  tenants: DemoTenant[];
  users: DemoUser[];
  customers: DemoCustomer[];
  loans: DemoLoan[];
  installments: DemoInstallment[];
  documents: never[];
  auditLogs: DemoAuditLog[];
}

export interface DemoSession { userId: string; tenantId: string; role: Role }

export class DemoHttpError extends Error {
  constructor(public status: number, message: string, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}
