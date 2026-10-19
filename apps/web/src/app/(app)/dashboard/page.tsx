"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { api, date, money } from "@/lib/api";

type Stats = {
  customers: number;
  byStatus: { status: string; count: number; principalCents: string }[];
  outstandingPrincipalCents: string;
  outstandingInterestCents: string;
  overdueInstallments: number;
  recentLoans: { id: string; principalCents: string; status: string; createdAt: string; customer: { fullName: string } }[];
};

export default function Dashboard() {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => void api<Stats>("/dashboard").then(setS), []);
  if (!s) return <p className="text-sm text-slate-500">Loading…</p>;

  const count = (st: string) => s.byStatus.find((b) => b.status === st)?.count ?? 0;
  const tiles = [
    ["Customers", String(s.customers)],
    ["Pending applications", String(count("PENDING"))],
    ["Active loans", String(count("APPROVED"))],
    ["Outstanding principal", money(s.outstandingPrincipalCents)],
    ["Interest still to collect", money(s.outstandingInterestCents)],
    ["Overdue installments", String(s.overdueInstallments)],
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {tiles.map(([label, value]) => (
          <div key={label} className="card">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="card overflow-x-auto">
          <h2 className="mb-3 font-medium">Loans by status</h2>
          <table className="w-full">
            <thead><tr><th className="th">Status</th><th className="th text-right">Count</th><th className="th text-right">Principal</th></tr></thead>
            <tbody>
              {s.byStatus.map((b) => (
                <tr key={b.status} className="border-t border-slate-100">
                  <td className="td"><StatusBadge status={b.status} /></td>
                  <td className="td text-right tabular-nums">{b.count}</td>
                  <td className="td text-right tabular-nums">{money(b.principalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card overflow-x-auto">
          <h2 className="mb-3 font-medium">Recent applications</h2>
          <table className="w-full">
            <tbody>
              {s.recentLoans.map((l) => (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="td"><Link className="text-indigo-600" href={`/loans/view?id=${l.id}`}>{l.customer.fullName}</Link></td>
                  <td className="td text-right tabular-nums">{money(l.principalCents)}</td>
                  <td className="td"><StatusBadge status={l.status} /></td>
                  <td className="td text-slate-500">{date(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
