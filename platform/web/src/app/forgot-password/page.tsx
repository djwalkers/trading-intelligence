"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";

export default function ForgotPasswordPage() {
  const { isConfigured, requestPasswordReset } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isConfigured) router.replace("/");
  }, [isConfigured, router]);

  if (!isConfigured) return null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const result = await requestPasswordReset(email);
    setIsSubmitting(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    setSubmitted(true);
  }

  return (
    <div className="panel w-full max-w-sm p-6">
      <h1 className="text-lg font-semibold text-ink-100">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-400">
        Enter your account email and we&apos;ll send a link to reset your password.
      </p>

      {submitted ? (
        <div className="mt-5 rounded-xl2 border border-accent-teal/30 bg-accent-teal/10 px-4 py-3 text-xs leading-relaxed text-accent-teal">
          If an account exists for that email, a reset link has been sent. Check your inbox.
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-ink-300">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="rounded-lg border border-base-600 bg-base-800 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
              placeholder="you@example.com"
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
            {isSubmitting ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}

      <p className="mt-5 text-center text-xs text-ink-500">
        <Link href="/sign-in" className="text-accent-teal hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
