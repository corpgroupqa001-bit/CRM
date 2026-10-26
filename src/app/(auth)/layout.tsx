import Link from "next/link";
import { CalendarCheck, IndianRupee, ListChecks, ShieldCheck } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const POINTS = [
  { icon: CalendarCheck, t: "Biometric attendance in real time", d: "Punches from your devices appear within a minute." },
  { icon: IndianRupee, t: "Payroll straight from attendance", d: "PF, ESI, PT and TDS calculated, payslips in minutes." },
  { icon: ListChecks, t: "Tasks and team chat", d: "Assign work and talk without sharing personal numbers." },
  { icon: ShieldCheck, t: "Every company kept separate", d: "Tenant isolation enforced in the database." },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-hero p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-accent/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-20 h-96 w-96 rounded-full bg-indigo-400/20 blur-3xl" />
        <Link href="/" className="relative flex items-center gap-2.5 text-lg font-semibold">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent text-[13px] font-bold">cg</span>
          corpgroup.com
        </Link>
        <div className="relative mt-auto max-w-md">
          <h2 className="text-[34px] font-semibold leading-[1.15] tracking-tight">People operations for every company you run.</h2>
          <ul className="mt-8 space-y-5">
            {POINTS.map(({ icon: Icon, t, d }) => (
              <li key={t} className="flex gap-3">
                <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white/10 ring-1 ring-white/15"><Icon className="h-4 w-4" /></span>
                <span><span className="block font-medium">{t}</span><span className="block text-sm text-[#c7d2fe]">{d}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 text-xs text-[#a5b4fc]">© {new Date().getFullYear()} corpgroup.com</p>
      </aside>
      <main className="relative flex flex-col items-center justify-center bg-surface px-5 py-10 sm:px-10">
        <ThemeToggle className="absolute right-4 top-4" />
        <Link href="/" className="mb-8 flex items-center gap-2 text-lg font-semibold text-slate-900 lg:hidden">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-xs font-bold text-white">cg</span>corpgroup.com
        </Link>
        <div className="w-full max-w-[380px]">{children}</div>
      </main>
    </div>
  );
}
