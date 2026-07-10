export type ToastCategory = "success" | "info" | "warning" | "error";

export interface Toast {
  id: string;
  category: ToastCategory;
  message: string;
  createdAt: number;
}

type Listener = () => void;

// Build 1.13.0 — a plain module-level external store, not a React Context. Notifications need to
// be pushable from ordinary TypeScript modules that aren't components (the resilient
// persistence/market-data stores, deep inside `src/lib/`), not just from within the provider tree,
// so a Context (which only components can read/write) would need prop-drilling or a global ref to
// reach those call sites anyway. `pushToast`/`dismissToast` are the single write path used by both
// components (via the `useToast` hook) and plain modules (direct import); `ToastViewport` is the
// only reader, subscribed via `useSyncExternalStore`.
let toasts: Toast[] = [];
const listeners = new Set<Listener>();

const MAX_TOASTS = 4;
const AUTO_DISMISS_MS = 6000;

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function pushToast(category: ToastCategory, message: string): string {
  const toast: Toast = {
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `toast-${Date.now()}-${Math.random()}`,
    category,
    message,
    createdAt: Date.now(),
  };
  toasts = [toast, ...toasts].slice(0, MAX_TOASTS);
  notifyListeners();

  if (typeof window !== "undefined") {
    window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
  }

  return toast.id;
}

export function dismissToast(id: string): void {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  notifyListeners();
}

export function subscribeToToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToastSnapshot(): Toast[] {
  return toasts;
}

// Deduplication helper for call sites outside components (e.g. a resilient store's catch block)
// that would otherwise push the same warning on every failed operation in a session — "avoid
// repeatedly displaying the same warning." Call sites own their own `alreadyWarned` flag; this
// just centralises the one-line pattern.
export function pushToastOnce(category: ToastCategory, message: string, warnedRef: { current: boolean }): void {
  if (warnedRef.current) return;
  warnedRef.current = true;
  pushToast(category, message);
}
