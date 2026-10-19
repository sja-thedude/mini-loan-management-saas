"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { api, date, money, pct } from "@/lib/api";

type Loan = { id: string; principalCents: string; annualRateBps: number; termMonths: number; purpose: string; status: string; createdAt: string; customer: { id: string; fullName: string } };
const STATUSES = ["", "PENDING", "APPROVED", "REJECTED", "CLOSED"];

export default function LoansPage() {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [customers, setCustomers] = useState<{ id: string; fullName: string }[]>([]);
  const [status, setStatus] = useState("");
  const [form, setForm] = useState({ customerId: "", principal: "", annualRatePercent: "", termMonths: "12", purpose: "" });
  const [error, setError] = useState("");

  const load = useCallback(() => api<Loan[]>(`/loans${status ? `?status=${status}` : ""}`).then(setLoans), [status]);
  useEffect(() => void load(), [load]);
  useEffect(() => void api<{ id: string; fullName: string }[]>("/customers").then(setCustomers), []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/loans", { body: { ...form, termMonths: Number(form.termMonths) }, idempotencyKey: crypto.randomUUID() });
      setForm({ customerId: "", principal: "", annualRatePercent: "", termMonths: "12", purpose: "" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Loans</h1>
          <select className="input ml-auto max-w-[180px]" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s || "All statuses"}</option>)}
          </select>
        </div>
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead className="bg-slate-50"><tr><th className="th">Customer</th><th className="th text-right">Principal</th><th className="th text-right">Rate</th><th className="th text-right">Term</th><th className="th">Status</th><th className="th">Applied</th></tr></thead>
            <tbody>
              {loans.map((l) => (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="td"><Link className="font-medium text-indigo-600" href={`/loans/view?id=${l.id}`}>{l.customer.fullName}</Link><div className="text-xs text-slate-500">{l.purpose}</div></td>
                  <td className="td text-right tabular-nums">{money(l.principalCents)}</td>
                  <td className="td text-right tabular-nums">{pct(l.annualRateBps)}</td>
                  <td className="td text-right">{l.termMonths} mo</td>
                  <td className="td"><StatusBadge status={l.status} /></td>
                  <td className="td text-slate-500">{date(l.createdAt)}</td>
                </tr>
              ))}
              {loans.length === 0 && <tr><td className="td text-slate-500" colSpan={6}>No loans.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <form onSubmit={create} className="card h-fit space-y-3">
        <h2 className="font-medium">New loan application</h2>
        <div>
          <label className="label">Customer</label>
          <select className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} required>
            <option value="">Select…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
          </select>
        </div>
        <div><label className="label">Principal (USD)</label><input className="input" inputMode="decimal" placeholder="15000.00" value={form.principal} onChange={(e) => setForm({ ...form, principal: e.target.value })} required /></div>
        <div><label className="label">Annual interest rate (%)</label><input className="input" inputMode="decimal" placeholder="9.5" value={form.annualRatePercent} onChange={(e) => setForm({ ...form, annualRatePercent: e.target.value })} required /></div>
        <div><label className="label">Term (months)</label><input className="input" type="number" min={1} max={360} value={form.termMonths} onChange={(e) => setForm({ ...form, termMonths: e.target.value })} required /></div>
        <div><label className="label">Purpose</label><input className="input" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} required /></div>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <button className="btn w-full">Submit application</button>
      </form>
    </div>
  );
}
