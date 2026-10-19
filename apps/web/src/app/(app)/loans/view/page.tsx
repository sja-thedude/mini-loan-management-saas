import { Suspense } from "react";
import LoanDetail from "./LoanDetail";

// Query-string route (/loans/view?id=…) so the page also works as a static export.
export default function LoanViewPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <LoanDetail />
    </Suspense>
  );
}
