"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/auth/AuthForm";
import { useAuth } from "@/lib/auth/auth-context";

export default function SignInPage() {
  const { isConfigured, isLoading, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!isConfigured || user) router.replace("/");
  }, [isConfigured, isLoading, user, router]);

  if (isLoading || !isConfigured || user) return null;

  return <AuthForm mode="sign-in" />;
}
