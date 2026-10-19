"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";

const fields = [
  ["companyName", "Company name", "text"],
  ["companySlug", "Company ID (used to sign in)", "text"],
  ["fullName", "Your name", "text"],
  ["email", "Email", "email"],
  ["password", "Password (min 10 chars)", "password"],
] as const;

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/auth/register", { body: form });
      router.replace("/dashboard");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm px-4">
      <h1 className="mb-6 text-2xl font-semibold">Register your company</h1>
      <form onSubmit={submit} className="card space-y-4">
        {fields.map(([name, label, type]) => (
          <div key={name}>
            <label className="label">{label}</label>
            <input className="input" type={type} value={form[name] ?? ""} onChange={(e) => setForm({ ...form, [name]: e.target.value })} required />
          </div>
        ))}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <button className="btn w-full">Create company</button>
      </form>
      <p className="mt-4 text-center text-sm"><Link className="text-indigo-600" href="/login">Back to sign in</Link></p>
    </div>
  );
}
