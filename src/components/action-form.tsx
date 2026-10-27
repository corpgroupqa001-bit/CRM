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
  const sent = useRef<FormData | null>(null);
  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.(state);
    }
    // React clears a form after every action, also a rejected one: put back what was typed so a
    // single wrong field (say a PAN) doesn't cost the whole form
    if (state?.error && ref.current && sent.current) restoreForm(ref.current, sent.current);
  }, [state, resetOnSuccess, onSuccess]);
  return (
    <form ref={ref} id={id} action={formAction} className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) { e.preventDefault(); return; }
        sent.current = new FormData(e.currentTarget);
      }}>
      {children}
      {state?.error && <p role="alert" className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"><span aria-hidden>⚠</span>{state.error}</p>}
      {state?.ok && <p role="status" className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"><span aria-hidden>✓</span>{state.ok}</p>}
    </form>
  );
}

/** Refills a form from the values it was submitted with (file pickers can't be refilled by a page). */
function restoreForm(form: HTMLFormElement, data: FormData) {
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) || !el.name || el.disabled) continue;
    const values = data.getAll(el.name).map(String);
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) el.checked = values.includes(el.value);
    else if (el instanceof HTMLSelectElement && el.multiple) for (const o of Array.from(el.options)) o.selected = values.includes(o.value);
    else if (!(el instanceof HTMLInputElement && (el.type === "file" || el.type === "hidden")) && values.length) el.value = values[0];
  }
}
