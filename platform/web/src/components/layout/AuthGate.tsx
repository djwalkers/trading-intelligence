"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";

// Gates every app page behind sign-in, but only when Supabase is actually configured — local
// prototype mode (no env vars) renders children unconditionally, unaffected by auth entirely.
export function AuthGate({ children }: { children: ReactNode }) {
  const { isConfigured, isLoading, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isConfigured || isLoading || user) return;
    router.replace("/sign-in");
  }, [isConfigured, isLoading, user, router]);

  if (!isConfigured) return <>{children}</>;

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-24 text-sm text-ink-500">
        Checking your session…
      </div>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}
