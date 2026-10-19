"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Client-side redirect works for both the server build and the static export.
export default function Home() {
  const router = useRouter();
  useEffect(() => router.replace("/dashboard"), [router]);
  return null;
}
