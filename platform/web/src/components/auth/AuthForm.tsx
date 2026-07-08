"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";

interface AuthFormProps {
  mode: "sign-in" | "sign-up";
}

export function AuthForm({ mode }: AuthFormProps) {
  const { signIn, signUp, sessionExpired } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setIsSubmitting(true);

    const result =
      mode === "sign-up" ? await signUp(email, password) : await signIn(email, password);

    setIsSubmitting(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    if (mode === "sign-up") {
      setInfo("Account created. Check your email to confirm your address, then sign in.");
      return;
    }

    router.replace("/");
  }

  return (
    <div className="panel w-full max-w-sm p-6">
      <h1 className="text-lg font-semibold text-ink-100">
        {mode === "sign-up" ? "Create an account" : "Sign in"}
      </h1>
      <p className="mt-1 text-sm text-ink-400">
        {mode === "sign-up"
          ? "Sign up to keep your paper trading history under your own account."
          : "Sign in to access your paper trading history."}
      </p>

      {mode === "sign-in" && sessionExpired ? (
        <div className="mt-4 rounded-xl2 border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-xs leading-relaxed text-accent-amber">
          Your session has expired. Please sign in again.
        </div>
      ) : null}

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

        <label className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-300">Password</span>
            {mode === "sign-in" ? (
              <Link href="/forgot-password" className="text-xs text-accent-teal hover:underline">
                Forgot password?
              </Link>
            ) : null}
          </div>
          <input
            type="password"
            required
            minLength={6}
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
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

        {info ? (
          <div className="rounded-xl2 border border-accent-teal/30 bg-accent-teal/10 px-4 py-3 text-xs leading-relaxed text-accent-teal">
            {info}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? "Please wait…" : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
      </form>

      <p className="mt-5 text-center text-xs text-ink-500">
        {mode === "sign-up" ? (
          <>
            Already have an account?{" "}
            <Link href="/sign-in" className="text-accent-teal hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            Don&apos;t have an account?{" "}
            <Link href="/sign-up" className="text-accent-teal hover:underline">
              Sign up
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
