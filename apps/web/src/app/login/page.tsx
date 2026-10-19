"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEMO_MODE, api } from "@/lib/api";

const DEMO_USERS = [
  ["acme", "admin", "Acme · Admin"],
  ["acme", "officer", "Acme · Officer"],
  ["bluebird", "admin", "Bluebird · Admin"],
  ["bluebird", "officer", "Bluebird · Officer"],
] as const;

export default function LoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ companySlug: "acme", email: "admin@acme.example", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e?: React.FormEvent, override?: typeof form) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", { body: override ?? form });
      router.replace("/dashboard");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-2xl font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-slate-500">Mini Loan Manager: a learning project with fictional data.</p>
      <form onSubmit={submit} className="card space-y-4">
        {(["companySlug", "email", "password"] as const).map((f) => (
          <div key={f}>
            <label className="label">{{ companySlug: "Company ID", email: "Email", password: "Password" }[f]}</label>
            <input className="input" type={f === "password" ? "password" : "text"} value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} required />
          </div>
        ))}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <button className="btn w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="text-center text-xs text-slate-500">Demo: acme or bluebird · admin@&lt;id&gt;.example · DemoPassword123!</p>
      </form>
      {DEMO_MODE && (
        <div className="card mt-4">
          <p className="mb-3 text-xs font-medium text-slate-600">One-click demo sign-in. Try both companies to see tenant isolation:</p>
          <div className="grid grid-cols-2 gap-2">
            {DEMO_USERS.map(([slug, who, label]) => (
              <button key={label} type="button" className="btn-secondary" disabled={busy}
                onClick={() => submit(undefined, { companySlug: slug, email: `${who}@${slug}.example`, password: "DemoPassword123!" })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="mt-4 text-center text-sm">New company? <Link className="text-indigo-600" href="/register">Register</Link></p>
    </div>
  );
}
