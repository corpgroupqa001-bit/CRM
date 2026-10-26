import Link from "next/link";
import { CalendarCheck, IndianRupee, ListChecks, ShieldCheck } from "lucide-react";

const POINTS = [
  { icon: CalendarCheck, t: "Biometric attendance in real time", d: "Punches from your devices appear within a minute." },
  { icon: IndianRupee, t: "Payroll straight from attendance", d: "PF, ESI, PT and TDS calculated, payslips in minutes." },
  { icon: ListChecks, t: "Tasks and team chat", d: "Assign work and talk without sharing personal numbers." },
  { icon: ShieldCheck, t: "Every company kept separate", d: "Tenant isolation enforced in the database." },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-brand-900 p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-600/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-20 h-96 w-96 rounded-full bg-indigo-400/20 blur-3xl" />
        <Link href="/" className="relative flex items-center gap-2.5 text-lg font-semibold">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20">cg</span>
          corpgroup.com
        </Link>
        <div className="relative mt-auto max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">People operations for every company you run.</h2>
          <ul className="mt-8 space-y-5">
            {POINTS.map(({ icon: Icon, t, d }) => (
              <li key={t} className="flex gap-3">
                <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15"><Icon className="h-4 w-4" /></span>
                <span><span className="block font-medium">{t}</span><span className="block text-sm text-indigo-200">{d}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 text-xs text-indigo-300">© {new Date().getFullYear()} corpgroup.com</p>
      </aside>
      <main className="flex flex-col items-center justify-center bg-white px-5 py-10 sm:px-10">
        <Link href="/" className="mb-8 flex items-center gap-2 text-lg font-semibold text-slate-900 lg:hidden">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm text-white">cg</span>corpgroup.com
        </Link>
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
