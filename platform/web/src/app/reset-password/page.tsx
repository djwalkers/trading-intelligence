"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";

// Reached via the link in a password-reset email, which establishes a temporary recovery
// session before the user ever lands here (Supabase's client handles this from the URL on load).
// If there's no session by the time this renders, the link was invalid, already used, or expired.
export default function ResetPasswordPage() {
  const { isConfigured, isLoading, user, updatePassword } = useAuth();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isConfigured) return null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const result = await updatePassword(password);
    setIsSubmitting(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    router.replace("/");
  }

  return (
    <div className="panel w-full max-w-sm p-6">
      <h1 className="text-lg font-semibold text-ink-100">Choose a new password</h1>

      {isLoading ? (
        <p className="mt-1 text-sm text-ink-400">Checking your reset link…</p>
      ) : !user ? (
        <>
          <p className="mt-1 text-sm text-ink-400">
            This password reset link is invalid or has expired.
          </p>
          <p className="mt-5 text-center text-xs text-ink-500">
            <Link href="/forgot-password" className="text-accent-teal hover:underline">
              Request a new link
            </Link>
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-400">Enter a new password for your account.</p>

          <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-ink-300">New password</span>
              <input
                type="password"
                required
                minLength={6}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="rounded-lg border border-base-600 bg-base-800 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
                placeholder="At least 6 characters"
              />
            </label>

            {error ? (
              <div className="rounded-xl2 border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-xs leading-relaxed text-accent-red">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? "Updating…" : "Update password"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
