import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { assertConfig, config } from "./config";
import { HttpError, forbidden } from "./http";

export const SESSION_COOKIE = "session";
const TTL_SECONDS = 8 * 60 * 60;

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: "ADMIN" | "OFFICER";
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}

export function issueSession(res: Response, ctx: AuthContext) {
  assertConfig();
  const token = jwt.sign({ tid: ctx.tenantId, role: ctx.role }, config.jwtSecret, {
    subject: ctx.userId,
    expiresIn: TTL_SECONDS,
    algorithm: "HS256",
  });
  // httpOnly: JavaScript cannot read it (XSS can't steal it). SameSite=Lax blocks
  // cross-site POSTs carrying it (CSRF). Secure requires HTTPS, so it is env-driven.
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: TTL_SECONDS * 1000,
    path: "/",
  });
  return token;
}

/** The tenant comes ONLY from the verified token, never from the URL or body. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = req.cookies?.[SESSION_COOKIE] ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
  if (!token) return next(new HttpError(401, "Authentication required", "unauthenticated"));
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (typeof p.sub !== "string" || typeof p.tid !== "string" || (p.role !== "ADMIN" && p.role !== "OFFICER")) {
      throw new Error("bad claims");
    }
    req.auth = { userId: p.sub, tenantId: p.tid, role: p.role };
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired session", "unauthenticated"));
  }
}

export function requireRole(role: AuthContext["role"]) {
  return (req: Request, _res: Response, next: NextFunction) =>
    req.auth?.role === role ? next() : next(forbidden());
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, "Authentication required", "unauthenticated");
  return req.auth;
}
