"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/Shell";
import { StatusBadge } from "@/components/StatusBadge";
import { api, date, money, pct } from "@/lib/api";

type Row = { number: number; dueDate: string; principalCents: string; interestCents: string; totalCents: string; status?: string; paidAt?: string | null; balanceAfterCents?: string };
type Loan = {
  id: string; status: string; principalCents: string; annualRateBps: number; termMonths: number; purpose: string;
  createdAt: string; decidedAt: string | null; decisionNote: string | null;
  customer: { fullName: string; email: string; monthlyIncomeCents: string };
  installments: Row[]; projectedSchedule: Row[] | null;
  documents: { id: string; fileName: string; createdAt: string }[];
};

export default function LoanDetail() {
  const id = useSearchParams().get("id") ?? "";
  const me = useMe();
  const [loan, setLoan] = useState<Loan | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => api<Loan>(`/loans/${id}`).then(setLoan).catch((e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };

  async function upload(file: File) {
    await act(async () => {
      const { upload } = await api<{ upload: { url: string; fields: Record<string, string> } }>(`/loans/${id}/documents`, { body: { fileName: file.name, contentType: file.type } });
      const fd = new FormData();
      Object.entries(upload.fields).forEach(([k, v]) => fd.append(k, v));
      fd.append("file", file); // must be the last field for S3 POST
      const res = await fetch(upload.url, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`S3 rejected the upload (${res.status}). Max 5 MB; PDF/PNG/JPEG only.`);
    });
  }

  async function download(docId: string) {
    await act(async () => {
      const { url } = await api<{ url: string }>(`/loans/${id}/documents/${docId}/download`);
      window.open(url, "_blank", "noopener");
    });
  }

  if (!loan) return <p className="text-sm text-slate-500">{error || "Loading…"}</p>;
  const rows = loan.installments.length ? loan.installments : loan.projectedSchedule ?? [];
  const totalInterest = rows.reduce((s, r) => s + BigInt(r.interestCents), 0n);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{loan.customer.fullName}: {money(loan.principalCents)}</h1>
        <StatusBadge status={loan.status} />
      </div>
      {error && <p className="rounded-md bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

      <div className="grid gap-4 md:grid-cols-4">
        {[["Rate", pct(loan.annualRateBps)], ["Term", `${loan.termMonths} months`], ["Total interest", money(totalInterest)], ["Customer income", `${money(loan.customer.monthlyIncomeCents)}/mo`]].map(([k, v]) => (
          <div key={k} className="card"><div className="text-xs text-slate-500">{k}</div><div className="mt-1 font-semibold tabular-nums">{v}</div></div>
        ))}
      </div>
      <p className="text-sm text-slate-600">Purpose: {loan.purpose} · Applied {date(loan.createdAt)}{loan.decidedAt && ` · Decided ${date(loan.decidedAt)}`}{loan.decisionNote && ` · “${loan.decisionNote}”`}</p>

      {loan.status === "PENDING" && me?.user.role === "ADMIN" && (
        <div className="card flex flex-wrap items-end gap-3">
          <div className="grow"><label className="label">Decision note (optional)</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <button className="btn bg-emerald-600 hover:bg-emerald-700" onClick={() => act(() => api(`/loans/${id}/approve`, { body: { note: note || undefined } }))}>Approve</button>
          <button className="btn bg-rose-600 hover:bg-rose-700" onClick={() => act(() => api(`/loans/${id}/reject`, { body: { note: note || undefined } }))}>Reject</button>
        </div>
      )}
      {loan.status === "PENDING" && me?.user.role !== "ADMIN" && <p className="text-sm text-slate-500">Awaiting an admin decision.</p>}

      <div className="card overflow-x-auto p-0">
        <h2 className="px-5 pt-4 font-medium">{loan.installments.length ? "Repayment schedule" : loan.projectedSchedule ? "Projected schedule (if approved today)" : "No schedule"}</h2>
        <table className="mt-2 w-full">
          <thead className="bg-slate-50"><tr><th className="th">#</th><th className="th">Due</th><th className="th text-right">Principal</th><th className="th text-right">Interest</th><th className="th text-right">Payment</th><th className="th">Status</th><th className="th" /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.number} className="border-t border-slate-100">
                <td className="td">{r.number}</td>
                <td className="td">{date(r.dueDate)}</td>
                <td className="td text-right tabular-nums">{money(r.principalCents)}</td>
                <td className="td text-right tabular-nums">{money(r.interestCents)}</td>
                <td className="td text-right font-medium tabular-nums">{money(r.totalCents)}</td>
                <td className="td">{r.status && <StatusBadge status={r.status} />}</td>
                <td className="td text-right">
                  {r.status === "DUE" && loan.status === "APPROVED" && (
                    <button className="btn-secondary" onClick={() => act(() => api(`/loans/${id}/installments/${r.number}/pay`, { method: "POST", idempotencyKey: crypto.randomUUID() }))}>Mark paid</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card space-y-3">
        <h2 className="font-medium">Documents (stored in S3)</h2>
        <input type="file" accept="application/pdf,image/png,image/jpeg" className="text-sm" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <ul className="space-y-1 text-sm">
          {loan.documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3">
              <span>{d.fileName}</span><span className="text-slate-400">{date(d.createdAt)}</span>
              <button className="text-indigo-600" onClick={() => download(d.id)}>Download</button>
            </li>
          ))}
          {loan.documents.length === 0 && <li className="text-slate-500">No documents.</li>}
        </ul>
      </div>
    </div>
  );
}
