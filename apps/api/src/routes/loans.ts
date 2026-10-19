import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../lib/audit";
import { auth, requireRole } from "../lib/auth";
import { withTenant } from "../lib/db";
import { HttpError, conflict, notFound } from "../lib/http";
import { idempotent } from "../lib/idempotency";
import { putMetric } from "../lib/metrics";
import { recordEvent } from "../lib/outbox";
import { buildSchedule, formatCents, parseAmountToCents, parsePercentToBps } from "../lib/money";
import { presignDownload, presignUpload } from "../lib/s3";

export const loansRouter = Router();

const MIN_PRINCIPAL = 100_00n;
const MAX_PRINCIPAL = 10_000_000_00n;

const createLoan = z.object({
  customerId: z.uuid(),
  principal: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "Amount like 15000.00")
    .transform(parseAmountToCents)
    .refine((c) => c >= MIN_PRINCIPAL && c <= MAX_PRINCIPAL, "Principal must be between 100.00 and 10,000,000.00"),
  annualRatePercent: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, "Percentage like 12.5").transform(parsePercentToBps),
  termMonths: z.number().int().min(1).max(360),
  purpose: z.string().trim().min(3).max(200),
});

const decision = z.object({ note: z.string().trim().max(500).optional() });
const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
const docRequest = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(ALLOWED_TYPES),
});

const idParam = (v: unknown) => z.uuid().parse(v);

loansRouter.get("/", async (req, res) => {
  const { tenantId } = auth(req);
  const status = z.enum(["PENDING", "APPROVED", "REJECTED", "CLOSED"]).optional().parse(req.query.status);
  const loans = await withTenant(tenantId, (tx) =>
    tx.loan.findMany({
      where: { tenantId, ...(status ? { status } : {}) },
      include: { customer: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  );
  res.json(loans);
});

loansRouter.post("/", idempotent(), async (req, res) => {
  const { tenantId, userId } = auth(req);
  const body = createLoan.parse(req.body);
  const loan = await withTenant(tenantId, async (tx) => {
    // Explicit ownership check gives a clean 404. (The composite FK would also reject it.)
    const customer = await tx.customer.findFirst({ where: { id: body.customerId, tenantId } });
    if (!customer) throw notFound("Customer");
    const l = await tx.loan.create({
      data: {
        tenantId,
        customerId: customer.id,
        principalCents: body.principal,
        annualRateBps: body.annualRatePercent,
        termMonths: body.termMonths,
        purpose: body.purpose,
        createdById: userId,
      },
    });
    await audit(tx, {
      tenantId, userId, action: "loan.created", entityType: "loan", entityId: l.id,
      metadata: { principal: formatCents(l.principalCents), rateBps: l.annualRateBps, termMonths: l.termMonths },
    });
    await recordEvent(tx, tenantId, "loan.created", { loanId: l.id, customerId: customer.id, principalCents: l.principalCents.toString() });
    return l;
  });
  res.status(201).json(loan);
});

loansRouter.get("/:id", async (req, res) => {
  const { tenantId } = auth(req);
  const id = idParam(req.params.id);
  const loan = await withTenant(tenantId, (tx) =>
    tx.loan.findFirst({
      where: { id, tenantId },
      include: { customer: true, installments: { orderBy: { number: "asc" } }, documents: { orderBy: { createdAt: "desc" } } },
    }),
  );
  if (!loan) throw notFound("Loan");
  // For pending loans, show what the schedule WOULD be if approved today.
  const projectedSchedule =
    loan.status === "PENDING" ? buildSchedule(loan.principalCents, loan.annualRateBps, loan.termMonths, new Date()) : null;
  res.json({ ...loan, projectedSchedule });
});

/**
 * Status transitions use a conditional UPDATE (WHERE status = 'PENDING'), so two
 * admins clicking at once cannot both succeed: one gets 409.
 */
async function decide(tenantId: string, userId: string, id: string, to: "APPROVED" | "REJECTED", note?: string) {
  const result = await withTenant(tenantId, async (tx) => {
    const now = new Date();
    const { count } = await tx.loan.updateMany({
      where: { id, tenantId, status: "PENDING" },
      data: { status: to, decidedById: userId, decidedAt: now, decisionNote: note },
    });
    if (count === 0) {
      const exists = await tx.loan.findFirst({ where: { id, tenantId }, select: { status: true } });
      if (!exists) throw notFound("Loan");
      throw conflict(`Loan is already ${exists.status}`);
    }
    const loan = await tx.loan.findFirstOrThrow({ where: { id, tenantId } });
    if (to === "APPROVED") {
      const schedule = buildSchedule(loan.principalCents, loan.annualRateBps, loan.termMonths, now);
      await tx.installment.createMany({
        data: schedule.map(({ balanceAfterCents: _b, ...row }) => ({ ...row, tenantId, loanId: loan.id })),
      });
    }
    await audit(tx, { tenantId, userId, action: `loan.${to.toLowerCase()}`, entityType: "loan", entityId: id, metadata: note ? { note } : undefined });
    const customer = await tx.customer.findFirstOrThrow({ where: { id: loan.customerId, tenantId }, select: { email: true, fullName: true } });
    await recordEvent(tx, tenantId, to === "APPROVED" ? "loan.approved" : "loan.rejected", {
      loanId: loan.id,
      principalCents: loan.principalCents.toString(),
      annualRateBps: loan.annualRateBps,
      termMonths: loan.termMonths,
      // Recipient details travel with the event so the notifier needs no DB access.
      recipient: { email: customer.email, fullName: customer.fullName },
    });
    return loan;
  });
  putMetric("LoanDecisions", { Decision: to });
  return result;
}

loansRouter.post("/:id/approve", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, userId } = auth(req);
  res.json(await decide(tenantId, userId, idParam(req.params.id), "APPROVED", decision.parse(req.body ?? {}).note));
});

loansRouter.post("/:id/reject", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, userId } = auth(req);
  res.json(await decide(tenantId, userId, idParam(req.params.id), "REJECTED", decision.parse(req.body ?? {}).note));
});

loansRouter.post("/:id/installments/:number/pay", idempotent(), async (req, res) => {
  const { tenantId, userId } = auth(req);
  const id = idParam(req.params.id);
  const number = z.coerce.number().int().min(1).max(360).parse(req.params.number);
  const result = await withTenant(tenantId, async (tx) => {
    const loan = await tx.loan.findFirst({ where: { id, tenantId } });
    if (!loan) throw notFound("Loan");
    if (loan.status !== "APPROVED") throw conflict(`Cannot record payments on a ${loan.status} loan`);
    const { count } = await tx.installment.updateMany({
      where: { tenantId, loanId: id, number, status: "DUE" },
      data: { status: "PAID", paidAt: new Date() },
    });
    if (count === 0) throw conflict("Installment not found or already paid");
    const remaining = await tx.installment.count({ where: { tenantId, loanId: id, status: "DUE" } });
    if (remaining === 0) await tx.loan.update({ where: { id }, data: { status: "CLOSED" } });
    await audit(tx, { tenantId, userId, action: "installment.paid", entityType: "loan", entityId: id, metadata: { number } });
    await recordEvent(tx, tenantId, "installment.paid", { loanId: id, number, remaining });
    if (remaining === 0) await recordEvent(tx, tenantId, "loan.closed", { loanId: id });
    return { loanStatus: remaining === 0 ? "CLOSED" : "APPROVED", remaining };
  });
  res.json(result);
});

/** Step 1 of upload: API records metadata and returns a short-lived presigned POST; browser uploads straight to S3. */
loansRouter.post("/:id/documents", async (req, res) => {
  const { tenantId, userId } = auth(req);
  const id = idParam(req.params.id);
  const body = docRequest.parse(req.body);
  const result = await withTenant(tenantId, async (tx) => {
    const loan = await tx.loan.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!loan) throw notFound("Loan");
    // Key is prefixed by tenant: the IAM task role and any future per-tenant policy can scope on it.
    const s3Key = `tenants/${tenantId}/loans/${id}/${randomUUID()}`;
    const upload = await presignUpload(s3Key, body.contentType);
    const doc = await tx.document.create({ data: { tenantId, loanId: id, s3Key, fileName: body.fileName, contentType: body.contentType, uploadedById: userId } });
    await audit(tx, { tenantId, userId, action: "document.upload_requested", entityType: "document", entityId: doc.id });
    return { document: doc, upload };
  });
  res.status(201).json(result);
});

loansRouter.get("/:id/documents/:docId/download", async (req, res) => {
  const { tenantId, userId } = auth(req);
  const id = idParam(req.params.id);
  const docId = idParam(req.params.docId);
  const url = await withTenant(tenantId, async (tx) => {
    const doc = await tx.document.findFirst({ where: { id: docId, loanId: id, tenantId } });
    if (!doc) throw notFound("Document");
    await audit(tx, { tenantId, userId, action: "document.downloaded", entityType: "document", entityId: doc.id });
    return presignDownload(doc.s3Key, doc.fileName);
  });
  if (!url) throw new HttpError(500, "Could not sign URL");
  res.json({ url, expiresInSeconds: 60 });
});
