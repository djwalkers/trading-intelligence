"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

interface AuthResult {
  error: string | null;
}

interface AuthContextValue {
  // Whether Supabase (and therefore auth) is configured at all. When false, the app runs in
  // local prototype mode and none of the sign-up/in/out functions do anything meaningful.
  isConfigured: boolean;
  // True only while the very first session check is in flight, so callers can avoid rendering
  // "signed out" state for an instant before the real answer is known.
  isLoading: boolean;
  user: User | null;
  // True when the user was signed in earlier in this browser tab and then transitioned to
  // signed-out without calling signOut() themselves — i.e. their session actually expired or was
  // revoked, as opposed to simply never having signed in. Cleared on the next successful sign-in.
  sessionExpired: boolean;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isSupabaseConfigured();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(configured);
  const [sessionExpired, setSessionExpired] = useState(false);
  const hadSessionRef = useRef(false);
  const signingOutRef = useRef(false);

  useEffect(() => {
    // isLoading's initial value already accounts for both of these (useState(configured) above),
    // so there is nothing to set synchronously here — only the async paths below need to.
    if (!configured) return;

    const client = getSupabaseClient();
    if (!client) return;

    let cancelled = false;

    client.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const initialUser = data.session?.user ?? null;
      hadSessionRef.current = initialUser !== null;
      setUser(initialUser);
      setIsLoading(false);
    });

    const { data: authListener } = client.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null;

      if (nextUser) {
        setSessionExpired(false);
      } else if (hadSessionRef.current && !signingOutRef.current) {
        // Had a session, now don't, and this wasn't a deliberate sign-out — the session lapsed
        // rather than the user choosing to leave.
        setSessionExpired(true);
      }

      hadSessionRef.current = nextUser !== null;
      signingOutRef.current = false;
      setUser(nextUser);
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
  }, [configured]);

  async function signUp(email: string, password: string): Promise<AuthResult> {
    const client = getSupabaseClient();
    if (!client) return { error: "Authentication is not configured for this deployment." };
    const { error } = await client.auth.signUp({ email, password });
    return { error: error?.message ?? null };
  }

  async function signIn(email: string, password: string): Promise<AuthResult> {
    const client = getSupabaseClient();
    if (!client) return { error: "Authentication is not configured for this deployment." };
    const { error } = await client.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }

  async function signOut(): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;
    signingOutRef.current = true;
    await client.auth.signOut();
  }

  return (
    <AuthContext.Provider
      value={{ isConfigured: configured, isLoading, user, sessionExpired, signUp, signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
