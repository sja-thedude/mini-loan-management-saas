import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import { requireAuth } from "./lib/auth";
import { prisma } from "./lib/db";
import { HttpError } from "./lib/http";
import { log } from "./lib/log";
import { authRouter } from "./routes/auth";
import { customersRouter } from "./routes/customers";
import { auditRouter, dashboardRouter } from "./routes/dashboard";
import { loansRouter } from "./routes/loans";
import { usersRouter } from "./routes/users";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  // BigInt cents are serialized as strings: JSON numbers would lose precision above 2^53.
  app.set("json replacer", (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("x-request-id", req.requestId);
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      log("info", "request", {
        requestId: req.requestId, method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n), tenantId: req.auth?.tenantId,
      });
    });
    next();
  });

  // Health check used by the ECS container health check. Verifies DB connectivity too.
  app.get("/api/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", requireAuth, usersRouter);
  app.use("/api/customers", requireAuth, customersRouter);
  app.use("/api/loans", requireAuth, loansRouter);
  app.use("/api/dashboard", requireAuth, dashboardRouter);
  app.use("/api/audit-logs", requireAuth, auditRouter);

  app.use((_req, _res, next) => next(new HttpError(404, "Route not found", "not_found")));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "validation_error", message: "Invalid input", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "conflict", message: "A record with these details already exists" });
    }
    if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "bad_json", message: "Malformed JSON" });
    // Never leak internals (stack traces, SQL) to the client; log them with the request id.
    log("error", "unhandled_error", { requestId: req.requestId, err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) });
    res.status(500).json({ error: "internal_error", message: "Something went wrong", requestId: req.requestId });
  });

  return app;
}
