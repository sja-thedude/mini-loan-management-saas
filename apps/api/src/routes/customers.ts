import { Router } from "express";
import { z } from "zod";
import { audit } from "../lib/audit";
import { auth, requireRole } from "../lib/auth";
import { withTenant } from "../lib/db";
import { notFound } from "../lib/http";
import { parseAmountToCents } from "../lib/money";
import { decryptNationalId, encryptNationalId } from "../lib/pii";

export const customersRouter = Router();

const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Amount like 1234.56").transform(parseAmountToCents);

const createCustomer = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.email().toLowerCase(),
  phone: z.string().trim().max(30).optional(),
  monthlyIncome: amount,
  // Fictional national ID (SSN-shaped). Encrypted with KMS before it reaches the database.
  nationalId: z.string().regex(/^\d{3}-\d{2}-\d{4}$/, "Format 123-45-6789").optional(),
});

/** Never send ciphertext to clients; expose only the masked last 4 digits. */
type WithSecret = { nationalIdCiphertext?: string | null; nationalIdLast4?: string | null };
const mask = <T extends WithSecret>({ nationalIdCiphertext: _c, nationalIdLast4, ...rest }: T) => ({
  ...rest,
  nationalIdMasked: nationalIdLast4 ? `***-**-${nationalIdLast4}` : null,
});

customersRouter.get("/", async (req, res) => {
  const { tenantId } = auth(req);
  const q = z.string().max(100).optional().parse(req.query.q);
  const customers = await withTenant(tenantId, (tx) =>
    tx.customer.findMany({
      where: {
        tenantId,
        ...(q ? { OR: [{ fullName: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { _count: { select: { loans: true } } },
    }),
  );
  res.json(customers.map(mask));
});

customersRouter.post("/", async (req, res) => {
  const { tenantId, userId } = auth(req);
  const { monthlyIncome, nationalId, ...rest } = createCustomer.parse(req.body);
  // Encrypt BEFORE opening the DB transaction: no network call to KMS while holding locks.
  const pii = nationalId ? await encryptNationalId(tenantId, nationalId) : undefined;
  const customer = await withTenant(tenantId, async (tx) => {
    const c = await tx.customer.create({
      data: { ...rest, tenantId, monthlyIncomeCents: monthlyIncome, nationalIdCiphertext: pii?.ciphertext, nationalIdLast4: pii?.last4 },
    });
    await audit(tx, { tenantId, userId, action: "customer.created", entityType: "customer", entityId: c.id, metadata: { hasNationalId: Boolean(pii) } });
    return c;
  });
  res.status(201).json(mask(customer));
});

customersRouter.get("/:id", async (req, res) => {
  const { tenantId } = auth(req);
  const id = z.uuid().parse(req.params.id);
  const customer = await withTenant(tenantId, (tx) =>
    tx.customer.findFirst({ where: { id, tenantId }, include: { loans: { orderBy: { createdAt: "desc" } } } }),
  );
  if (!customer) throw notFound("Customer");
  res.json(mask(customer));
});

/** Reveal PII: ADMIN only, decrypted on demand, and every reveal is audited. */
customersRouter.get("/:id/national-id", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, userId } = auth(req);
  const id = z.uuid().parse(req.params.id);
  const customer = await withTenant(tenantId, async (tx) => {
    const c = await tx.customer.findFirst({ where: { id, tenantId }, select: { id: true, nationalIdCiphertext: true } });
    if (c?.nationalIdCiphertext) await audit(tx, { tenantId, userId, action: "customer.pii_revealed", entityType: "customer", entityId: id });
    return c;
  });
  if (!customer) throw notFound("Customer");
  if (!customer.nationalIdCiphertext) throw notFound("National ID");
  res.setHeader("Cache-Control", "no-store");
  res.json({ nationalId: await decryptNationalId(tenantId, customer.nationalIdCiphertext) });
});
