"use client";

import { DEMO_MODE } from "@/lib/api";

export function DemoBanner() {
  if (!DEMO_MODE) return null;
  async function reset() {
    const { resetDemoData } = await import("@/lib/demo/server");
    await resetDemoData();
    location.reload();
  }
  return (
    <div className="bg-indigo-950 px-4 py-2 text-center text-xs text-indigo-100">
      <strong>Static demo</strong> served from Amazon S3 via CloudFront. The API runs in your browser on fictional demo data,
      saved only in this browser.{" "}
      <button onClick={reset} className="underline underline-offset-2 hover:text-white">Reset demo data</button>
    </div>
  );
}
