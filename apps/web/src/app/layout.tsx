import type { Metadata } from "next";
import { DemoBanner } from "@/components/DemoBanner";
import "./globals.css";

export const metadata: Metadata = { title: "Mini Loan Manager", description: "Learning project: multi-tenant loan management (fictional data)" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
