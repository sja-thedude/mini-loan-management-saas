"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Log = { id: string; action: string; entityType: string; entityId: string; userId: string | null; metadata: unknown; createdAt: string };

export default function AuditPage() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState("");
  useEffect(() => void api<Log[]>("/audit-logs").then(setLogs).catch((e) => setError(e.message)), []);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit log</h1>
      <p className="text-sm text-slate-500">Append-only: the database denies UPDATE and DELETE on this table.</p>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Action</th><th className="th">Entity</th><th className="th">Details</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="td whitespace-nowrap text-slate-500">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="td font-mono text-xs">{l.action}</td>
                <td className="td text-xs">{l.entityType} <span className="text-slate-400">{l.entityId.slice(0, 8)}</span></td>
                <td className="td font-mono text-xs text-slate-500">{l.metadata ? JSON.stringify(l.metadata) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
