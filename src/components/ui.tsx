import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { label } from "@/lib/format";

export function PageHeader({ title, subtitle, actions, eyebrow }: {
  title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[13px] font-medium text-slate-500">{eyebrow}</div>}
        <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-slate-900 sm:text-[26px]">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-slate-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, actions, children, className = "", pad = true }: {
  title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; pad?: boolean;
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      {(title || actions) && (
        <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={pad ? "p-4 sm:p-5" : ""}>{children}</div>
    </section>
  );
}

const TONE: Record<string, { text: string; icon: string }> = {
  slate: { text: "text-slate-900", icon: "bg-slate-100 text-slate-600" },
  green: { text: "text-slate-900", icon: "bg-emerald-50 text-emerald-600" },
  red: { text: "text-slate-900", icon: "bg-rose-50 text-rose-600" },
  amber: { text: "text-slate-900", icon: "bg-amber-50 text-amber-600" },
  brand: { text: "text-slate-900", icon: "bg-brand-50 text-brand-600" },
};

export function Stat({ label: l, value, hint, tone = "slate", icon: Icon }: {
  label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: string; icon?: LucideIcon;
}) {
  const t = TONE[tone] ?? TONE.slate;
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        {Icon && <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${t.icon}`}><Icon className="h-3.5 w-3.5" /></span>}
        <div className="truncate text-[13px] font-medium text-slate-600">{l}</div>
      </div>
      <div className={`mt-2.5 text-[28px] font-semibold leading-none tracking-tight tabular-nums ${t.text}`}>{value}</div>
      {hint && <div className="mt-2 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

// status → [background, text, dot]
const G = ["bg-emerald-50 text-emerald-700", "bg-emerald-500"] as const;
const A = ["bg-amber-50 text-amber-800", "bg-amber-500"] as const;
const R = ["bg-rose-50 text-rose-700", "bg-rose-500"] as const;
const S = ["bg-sky-50 text-sky-700", "bg-sky-500"] as const;
const V = ["bg-violet-50 text-violet-700", "bg-violet-500"] as const;
const N = ["bg-slate-100 text-slate-600", "bg-slate-400"] as const;
const T = ["bg-teal-50 text-teal-700", "bg-teal-500"] as const;
const O = ["bg-orange-50 text-orange-700", "bg-orange-500"] as const;
const BADGE: Record<string, readonly [string, string]> = {
  present: G, late: A, early_out: A, half_day: O, absent: R, missed_punch: R, on_leave: S, holiday: V, weekly_off: N,
  on_duty: T, wfh: T, pending: A, approved: G, rejected: R, cancelled: N, active: G, archived: N, inactive: N, exited: N,
  notice: A, draft: A, locked: G, superseded: N, reopened: R, online: G, offline: R, planned: N, on_hold: A,
  completed: G, todo: N, in_progress: S, in_review: V, done: G, blocked: R, low: N, medium: S, high: A, urgent: R,
  paid: G, failed: R, owner: V, hr: T, manager: A, employee: N,
};

export function Badge({ value, text }: { value: string | null | undefined; text?: string }) {
  const [cls, dot] = BADGE[value ?? ""] ?? N;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {text ?? label(value)}
    </span>
  );
}

export function Table({ head, children, empty }: { head: React.ReactNode[]; children: React.ReactNode; empty?: React.ReactNode }) {
  const rows = Array.isArray(children) ? children.flat().filter(Boolean) : children ? [children] : [];
  return (
    <div className="thin-scroll overflow-x-auto">
      <table className="min-w-full">
        <thead className="border-b border-slate-100 bg-slate-50">
          <tr>{head.map((h, i) => <th key={i} className="th">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50">
          {rows.length ? children : (
            <tr><td colSpan={head.length} className="px-4 py-12 text-center">
              <Inbox className="mx-auto mb-2 h-6 w-6 text-slate-300" />
              <span className="text-sm text-slate-500">{empty ?? "Nothing here yet."}</span>
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Field({ label: l, children, hint, className = "" }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <label className={`block ${className}`}>
      {l && <span className="label">{l}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Empty({ title, children, action, icon: Icon = Inbox }: { title: string; children?: React.ReactNode; action?: React.ReactNode; icon?: LucideIcon }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600"><Icon className="h-5 w-5" /></span>
      <div className="text-base font-semibold text-slate-900">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Tabs({ tabs, active }: { tabs: { href: string; label: string; key: string }[]; active: string }) {
  return (
    <div className="relative mb-6 max-w-full">
      <nav className={`thin-scroll flex w-max max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-surface p-1 shadow-(--shadow-card) ${tabs.length > 3 ? "max-sm:[mask-image:linear-gradient(90deg,#000_82%,transparent)]" : ""}`}>
        {tabs.map((t) => (
          <Link key={t.key} href={t.href} scroll={false} aria-current={t.key === active ? "page" : undefined}
            className={`whitespace-nowrap rounded-[9px] px-3.5 py-1.5 text-sm font-medium transition-colors ${t.key === active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

const AVATAR_BG = ["bg-indigo-100 text-indigo-700", "bg-sky-100 text-sky-700", "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-800", "bg-rose-100 text-rose-700", "bg-violet-100 text-violet-700", "bg-teal-100 text-teal-700"];

export function Avatar({ name, url, size = 32 }: { name: string; url?: string | null; size?: number }) {
  const initials = name.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
  const tone = AVATAR_BG[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_BG.length];
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={name} width={size} height={size} className="shrink-0 rounded-full object-cover ring-1 ring-black/5" style={{ width: size, height: size }} />
  ) : (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${tone}`}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}>{initials || "?"}</span>
  );
}

/** Small key/value list used in detail cards */
export function Detail({ items }: { items: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-100 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="flex justify-between gap-4 py-2 first:pt-0 last:pb-0"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-900">{v}</dd></div>
      ))}
    </dl>
  );
}
