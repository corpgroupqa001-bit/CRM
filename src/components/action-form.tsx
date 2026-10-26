"use client";
import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/actions";

export function SubmitButton({ children, className = "btn-primary", pendingText, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || rest.disabled} className={className} {...rest}>
      {pending ? pendingText ?? "Working…" : children}
    </button>
  );
}

/** Form bound to a server action returning ActionState; shows the error / success message inline. */
export function ActionForm({ action, children, className = "space-y-4", confirm, resetOnSuccess = false, onSuccess, id }: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  resetOnSuccess?: boolean;
  onSuccess?: (s: ActionState) => void;
  /** lets inputs elsewhere on the page join this form via form="<id>" (bulk selections) */
  id?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.(state);
    }
  }, [state, resetOnSuccess, onSuccess]);
  return (
    <form ref={ref} id={id} action={formAction} className={className}
      onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      {children}
      {state?.error && <p role="alert" className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"><span aria-hidden>⚠</span>{state.error}</p>}
      {state?.ok && <p role="status" className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"><span aria-hidden>✓</span>{state.ok}</p>}
    </form>
  );
}
