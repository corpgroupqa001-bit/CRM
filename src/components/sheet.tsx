"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * A button that opens a side panel (a bottom sheet on phones) holding a form, so a row action
 * doesn't squeeze its fields into a table cell. Esc, the close button or the backdrop closes it.
 */
export function Sheet({ trigger, title, description, children, triggerClassName = "btn-secondary btn-sm" }: {
  trigger: React.ReactNode; title: string; description?: React.ReactNode; children: React.ReactNode; triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    body.current?.querySelector<HTMLElement>("select, input:not([type=hidden]), textarea, button")?.focus();
    const btn = opener.current;
    return () => { window.removeEventListener("keydown", onKey); btn?.focus(); };
  }, [open]);

  return (
    <>
      <button ref={opener} type="button" className={triggerClassName} onClick={() => setOpen(true)} aria-haspopup="dialog">{trigger}</button>
      {open && (
        <div className="fixed inset-0 z-50 text-left">
          <div className="absolute inset-0 bg-scrim backdrop-blur-[1px]" onClick={() => setOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label={title}
            className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border border-slate-200 bg-surface shadow-(--shadow-pop) sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[400px] sm:rounded-none sm:border-y-0 sm:border-r-0">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-slate-900">{title}</h2>
                {description && <div className="mt-0.5 text-[13px] text-slate-500">{description}</div>}
              </div>
              <button type="button" onClick={() => setOpen(false)} className="-mr-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-slate-500 hover:bg-slate-100" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
            <div ref={body} className="thin-scroll flex-1 overflow-y-auto px-5 py-5">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
