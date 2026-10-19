export class ApiError extends Error {
  constructor(public status: number, message: string, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

/** Static demo build: route calls to the in-browser mock API (loaded only in that build). */
async function demoApi<T>(path: string, method: string, body: unknown): Promise<T> {
  const { demoRequest } = await import("./demo/server");
  const { DemoHttpError } = await import("./demo/types");
  try {
    return (await demoRequest(path, method, body)) as T;
  } catch (e) {
    if (e instanceof DemoHttpError) {
      if (e.status === 401 && !location.pathname.startsWith("/login") && !location.pathname.startsWith("/register")) location.href = "/login/";
      throw new ApiError(e.status, e.message, e.issues);
    }
    throw e;
  }
}

/** Same-origin fetch: the httpOnly session cookie is sent automatically. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method = init.method ?? (init.body ? "POST" : "GET");
  if (DEMO_MODE) return demoApi<T>(path, method, init.body);
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      // Money-moving requests carry a key so a network retry can't double-create or double-pay.
      ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login") && !location.pathname.startsWith("/register")) {
    location.href = "/login";
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.issues?.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join("; ");
    throw new ApiError(res.status, detail || data.message || `Request failed (${res.status})`, data.issues);
  }
  return data as T;
}

/** Format integer cents (string from the API) without converting to a float. */
export function money(cents: string | number | bigint | null | undefined): string {
  const n = BigInt(cents ?? 0);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = (abs / 100n).toLocaleString("en-US");
  return `${neg ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export const pct = (bps: number) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
export const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }) : "—");

export type Me = { user: { id: string; email: string; fullName: string; role: "ADMIN" | "OFFICER" }; tenant: { id: string; name: string; slug: string } };
