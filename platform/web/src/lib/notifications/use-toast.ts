"use client";

import { pushToast, type ToastCategory } from "./toast-bus";

// Thin ergonomic wrapper for components — `notify` is the exact same function plain (non-React)
// modules import directly from toast-bus.ts, so a component and a persistence store call the
// identical path and can never drift into two different notification systems.
export function useToast() {
  function notify(category: ToastCategory, message: string): void {
    pushToast(category, message);
  }

  return { notify };
}
