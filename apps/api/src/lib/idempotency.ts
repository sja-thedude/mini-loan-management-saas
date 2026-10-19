import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { auth } from "./auth";
import { withTenant } from "./db";
import { HttpError } from "./http";

/**
 * Idempotency-Key support for money-moving endpoints (Stripe-style).
 * 1. INSERT the key first (primary key = tenant+key). A concurrent duplicate hits the unique
 *    constraint and gets 409 instead of executing twice.
 * 2. Run the handler; store its status + body.
 * 3. A later retry with the same key and same body replays the stored response.
 *    Same key + different body -> 422 (client bug).
 * 5xx responses release the key so the client can safely retry.
 */
export function idempotent() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("Idempotency-Key");
    if (!key) return next();
    if (!/^[\w-]{8,100}$/.test(key)) return next(new HttpError(400, "Idempotency-Key must be 8-100 chars [A-Za-z0-9_-]", "bad_idempotency_key"));
    const { tenantId } = auth(req);
    const requestHash = createHash("sha256").update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`).digest("hex");

    try {
      await withTenant(tenantId, (tx) => tx.idempotencyKey.create({ data: { tenantId, key, requestHash } }));
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) return next(err);
      const existing = await withTenant(tenantId, (tx) => tx.idempotencyKey.findUnique({ where: { tenantId_key: { tenantId, key } } }));
      if (!existing) return next(new HttpError(409, "Request with this Idempotency-Key is in progress", "idempotency_in_progress"));
      if (existing.requestHash !== requestHash) return next(new HttpError(422, "Idempotency-Key was already used with a different request", "idempotency_mismatch"));
      if (existing.responseStatus === null) return next(new HttpError(409, "Request with this Idempotency-Key is in progress", "idempotency_in_progress"));
      res.setHeader("Idempotent-Replayed", "true");
      return res.status(existing.responseStatus).json(existing.responseBody);
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      // Serialize exactly as Express would (BigInt -> string) before storing.
      const stored = JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      const persist =
        status >= 500
          ? withTenant(tenantId, (tx) => tx.idempotencyKey.delete({ where: { tenantId_key: { tenantId, key } } }))
          : withTenant(tenantId, (tx) => tx.idempotencyKey.update({ where: { tenantId_key: { tenantId, key } }, data: { responseStatus: status, responseBody: stored } }));
      persist.catch(() => undefined).finally(() => originalJson(body));
      return res;
    };
    next();
  };
}
