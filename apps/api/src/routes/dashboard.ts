import { Router } from "express";
import { auth, requireRole } from "../lib/auth";
import { withTenant } from "../lib/db";

export const dashboardRouter = Router();
export const auditRouter = Router();

dashboardRouter.get("/", async (req, res) => {
  const { tenantId } = auth(req);
  const stats = await withTenant(tenantId, async (tx) => {
    const byStatus = await tx.loan.groupBy({
      by: ["status"],
      where: { tenantId },
      _count: { _all: true },
      _sum: { principalCents: true },
    });
    const outstanding = await tx.installment.aggregate({
      where: { tenantId, status: "DUE" },
      _sum: { principalCents: true, interestCents: true },
    });
    const overdue = await tx.installment.count({ where: { tenantId, status: "DUE", dueDate: { lt: new Date() } } });
    const customers = await tx.customer.count({ where: { tenantId } });
    const recentLoans = await tx.loan.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { customer: { select: { fullName: true } } },
    });
    return {
      customers,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all, principalCents: s._sum.principalCents ?? 0n })),
      outstandingPrincipalCents: outstanding._sum.principalCents ?? 0n,
      outstandingInterestCents: outstanding._sum.interestCents ?? 0n,
      overdueInstallments: overdue,
      recentLoans,
    };
  });
  res.json(stats);
});

auditRouter.get("/", requireRole("ADMIN"), async (req, res) => {
  const { tenantId } = auth(req);
  res.json(await withTenant(tenantId, (tx) => tx.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 200 })));
});
