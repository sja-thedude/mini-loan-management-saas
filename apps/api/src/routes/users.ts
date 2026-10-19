import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../lib/audit";
import { auth, requireRole } from "../lib/auth";
import { withTenant } from "../lib/db";

export const usersRouter = Router();

const createUser = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.email().toLowerCase(),
  password: z.string().min(10).max(128),
  role: z.enum(["ADMIN", "OFFICER"]),
});

const publicFields = { id: true, email: true, fullName: true, role: true, createdAt: true } as const;

usersRouter.get("/", async (req, res) => {
  const { tenantId } = auth(req);
  res.json(await withTenant(tenantId, (tx) => tx.user.findMany({ where: { tenantId }, select: publicFields, orderBy: { createdAt: "asc" } })));
});

usersRouter.post("/", requireRole("ADMIN"), async (req, res) => {
  const { tenantId, userId } = auth(req);
  const body = createUser.parse(req.body);
  const passwordHash = await bcrypt.hash(body.password, 12);
  const user = await withTenant(tenantId, async (tx) => {
    const u = await tx.user.create({
      data: { tenantId, email: body.email, fullName: body.fullName, role: body.role, passwordHash },
      select: publicFields,
    });
    await audit(tx, { tenantId, userId, action: "user.created", entityType: "user", entityId: u.id, metadata: { role: u.role } });
    return u;
  });
  res.status(201).json(user);
});
