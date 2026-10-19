"use client";

import { useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/Shell";
import { DEMO_MODE, api, date, money } from "@/lib/api";

type Customer = { id: string; fullName: string; email: string; phone: string | null; monthlyIncomeCents: string; nationalIdMasked?: string | null; createdAt: string; _count: { loans: number } };

export default function CustomersPage() {
  const [list, setList] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const me = useMe();
  const [form, setForm] = useState({ fullName: "", email: "", phone: "", monthlyIncome: "", nationalId: "" });
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  async function reveal(id: string) {
    try {
      const { nationalId } = await api<{ nationalId: string }>(`/customers/${id}/national-id`);
      setRevealed((r) => ({ ...r, [id]: nationalId }));
      setTimeout(() => setRevealed((r) => { const { [id]: _gone, ...rest } = r; return rest; }), 10_000); // auto-hide
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const load = useCallback(() => api<Customer[]>(`/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setList), [q]);
  useEffect(() => void load(), [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/customers", { body: { ...form, phone: form.phone || undefined, nationalId: form.nationalId || undefined } });
      setForm({ fullName: "", email: "", phone: "", monthlyIncome: "", nationalId: "" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Customers</h1>
          <input className="input ml-auto max-w-xs" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Email</th><th className="th">National ID</th><th className="th text-right">Monthly income</th><th className="th text-right">Loans</th><th className="th">Added</th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="td font-medium">{c.fullName}</td>
                  <td className="td">{c.email}</td>
                  <td className="td font-mono text-xs">
                    {revealed[c.id] ?? c.nationalIdMasked ?? "—"}
                    {c.nationalIdMasked && !revealed[c.id] && me?.user.role === "ADMIN" && (
                      <button className="ml-2 text-indigo-600" onClick={() => reveal(c.id)}>Reveal</button>
                    )}
                  </td>
                  <td className="td text-right tabular-nums">{money(c.monthlyIncomeCents)}</td>
                  <td className="td text-right">{c._count.loans}</td>
                  <td className="td text-slate-500">{date(c.createdAt)}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td className="td text-slate-500" colSpan={6}>No customers yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <form onSubmit={create} className="card h-fit space-y-3">
        <h2 className="font-medium">Add customer</h2>
        <div><label className="label">Full name</label><input className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required /></div>
        <div><label className="label">Email</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
        <div><label className="label">Phone (optional)</label><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
        {!DEMO_MODE && (
          <div>
            <label className="label">National ID (optional, fictional; encrypted with KMS)</label>
            <input className="input font-mono" placeholder="123-45-6789" value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} />
          </div>
        )}
        <div><label className="label">Monthly income (USD)</label><input className="input" inputMode="decimal" placeholder="4500.00" value={form.monthlyIncome} onChange={(e) => setForm({ ...form, monthlyIncome: e.target.value })} required /></div>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <button className="btn w-full">Add customer</button>
      </form>
    </div>
  );
}
