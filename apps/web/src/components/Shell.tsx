"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api, type Me } from "@/lib/api";

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

export function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    api<Me>("/auth/me").then(setMe).catch(() => router.replace("/login"));
  }, [router]);

  if (!me) return <div className="p-10 text-sm text-slate-500">Loading…</div>;

  const nav = [
    ["/dashboard", "Dashboard"],
    ["/customers", "Customers"],
    ["/loans", "Loans"],
    ...(me.user.role === "ADMIN" ? [["/audit", "Audit log"]] : []),
  ];

  return (
    <MeContext.Provider value={me}>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="font-semibold text-indigo-700">{me.tenant.name}</div>
          <nav className="flex gap-4 text-sm">
            {nav.map(([href, label]) => (
              <Link key={href} href={href} className={pathname.startsWith(href) ? "font-semibold text-slate-900" : "text-slate-500 hover:text-slate-800"}>
                {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-500">
            <span>{me.user.fullName} · {me.user.role}</span>
            <button className="btn-secondary" onClick={async () => { await api("/auth/logout", { method: "POST" }); router.replace("/login"); }}>
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-slate-400">Learning project · fictional data only · not a production financial system</footer>
    </MeContext.Provider>
  );
}
