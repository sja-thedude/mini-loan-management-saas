import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { audit } from "../lib/audit";
import { SESSION_COOKIE, auth, issueSession, requireAuth } from "../lib/auth";
import { prisma, withTenant } from "../lib/db";
import { HttpError, conflict } from "../lib/http";

export const authRouter = Router();

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3-40 chars: a-z, 0-9, hyphen");
const password = z.string().min(10, "At least 10 characters").max(128);

const registerSchema = z.object({
  companyName: z.string().trim().min(2).max(100),
  companySlug: slug,
  fullName: z.string().trim().min(2).max(100),
  email: z.email().toLowerCase(),
  password,
});

const loginSchema = z.object({ companySlug: slug, email: z.email().toLowerCase(), password: z.string().max(128) });

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
// Compared against when the user doesn't exist, so response time doesn't reveal valid emails.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 12);

/** Self-service sign-up: creates a tenant (company) and its first ADMIN user. */
authRouter.post("/register", limiter, async (req, res) => {
  const body = registerSchema.parse(req.body);
  if (await prisma.tenant.findUnique({ where: { slug: body.companySlug } })) throw conflict("Company slug is taken");

  const tenantId = randomUUID();
  const passwordHash = await bcrypt.hash(body.password, 12);
  const user = await withTenant(tenantId, async (tx) => {
    await tx.tenant.create({ data: { id: tenantId, name: body.companyName, slug: body.companySlug } });
    const u = await tx.user.create({
      data: { tenantId, email: body.email, fullName: body.fullName, passwordHash, role: "ADMIN" },
    });
    await audit(tx, { tenantId, userId: u.id, action: "tenant.created", entityType: "tenant", entityId: tenantId });
    return u;
  });
  issueSession(res, { userId: user.id, tenantId, role: user.role });
  res.status(201).json({ user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } });
});

authRouter.post("/login", limiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const tenant = await prisma.tenant.findUnique({ where: { slug: body.companySlug } });
  const user = tenant
    ? await withTenant(tenant.id, (tx) => tx.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: body.email } } }))
    : null;
  const ok = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
  if (!tenant || !user || !ok) throw new HttpError(401, "Invalid company, email or password", "invalid_credentials");

  await withTenant(tenant.id, (tx) =>
    audit(tx, { tenantId: tenant.id, userId: user.id, action: "user.login", entityType: "user", entityId: user.id }),
  );
  const token = issueSession(res, { userId: user.id, tenantId: tenant.id, role: user.role });
  res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const { tenantId, userId } = auth(req);
  const data = await withTenant(tenantId, async (tx) => ({
    user: await tx.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, email: true, fullName: true, role: true } }),
    tenant: await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } }),
  }));
  if (!data.user) throw new HttpError(401, "Session user no longer exists", "unauthenticated");
  res.json(data);
});
