"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Bell, Building2, CalendarCheck, Check, ChevronsUpDown, CornerDownLeft, Fingerprint, FolderKanban, IndianRupee,
  LayoutDashboard, ListChecks, LogOut, Megaphone, Menu, MessageSquare, Plane, Receipt, Search, Settings, UserCircle,
  Users, X, KeyRound, ShieldCheck,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/ui";
import { NavLink } from "@/components/nav-link";
import { SessionGuard } from "@/components/session-guard";

const ICONS = { LayoutDashboard, Users, Fingerprint, CalendarCheck, Plane, IndianRupee, Receipt, FolderKanban, ListChecks, MessageSquare, Megaphone, Settings, UserCircle };

type Props = {
  companyId: string;
  companyName: string;
  logoUrl: string | null;
  userName: string;
  userEmail: string;
  roleLabel: string;
  nav: { href: string; label: string; icon: string; group: string }[];
  groups: string[];
  companies: { id: string; name: string; role: string }[];
  isMultiOwner: boolean;
  /** platform Super Admin: companies are added in /admin */
  canAddCompany?: boolean;
  unread: number;
  userId: string;
  idleMinutes: number;
  logout: () => Promise<void>;
  children: React.ReactNode;
};

type Hit = { type: string; title: string; sub: string; href: string };

export function Shell(p: Props) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [menu, setMenu] = useState(false);
  const [unread, setUnread] = useState(p.unread);
  const [searchOpen, setSearchOpen] = useState(false);
  const base = `/c/${p.companyId}/`;

  useEffect(() => setUnread(p.unread), [p.unread]);
  useEffect(() => { setOpen(false); setMenu(false); setSwitcher(false); }, [path]);

  // live notification count (Supabase Realtime, RLS-filtered)
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`notif-${p.userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${p.userId}` },
        (payload) => { if ((payload.new as { kind?: string }).kind !== "chat") setUnread((n) => n + 1); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [p.userId]);

  // AUTH-12: sign out after the idle timeout (default 30 min)
  const { logout, idleMinutes } = p;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(t); t = setTimeout(() => { logout(); }, idleMinutes * 60_000); };
    const evs = ["mousemove", "keydown", "click", "touchstart", "scroll"];
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(t); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, [logout, idleMinutes]);

  // ⌘K / Ctrl+K opens search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = p.nav.map((n) => base + n.href).filter((h) => path === h || path.startsWith(h + "/"))
    .sort((a, b) => b.length - a.length)[0];
  const current = p.nav.find((n) => base + n.href === active);

  const sidebar = (
    <nav className="flex h-full flex-col bg-white">
      <div className="relative px-3 pb-2 pt-3">
        <button onClick={() => setSwitcher((s) => !s)}
          className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 p-2 text-left transition hover:bg-slate-50">
          {p.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.logoUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
          ) : (
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white">
              {p.companyName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-slate-900">{p.companyName}</span>
            <span className="block truncate text-xs text-slate-500">{p.roleLabel}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
        {switcher && (
          <div className="absolute left-3 right-3 top-full z-30 mt-1 rounded-xl border border-slate-200 bg-white p-1 shadow-(--shadow-pop)">
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Companies</div>
            {p.companies.map((c) => (
              <button key={c.id} onClick={() => router.push(`/c/${c.id}/dashboard`)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-100">
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.id === p.companyId && <Check className="h-4 w-4 text-brand-600" />}
              </button>
            ))}
            {p.isMultiOwner && (
              <Link href="/owner" className="mt-1 flex items-center gap-2 border-t border-slate-100 px-2 pb-1.5 pt-2 text-sm text-slate-700 hover:text-slate-900">
                <Building2 className="h-4 w-4" /> All companies overview
              </Link>
            )}
            {p.canAddCompany && <Link href="/admin" className="flex items-center gap-2 px-2 py-1.5 text-sm text-brand-700 hover:underline">+ Add a company</Link>}
          </div>
        )}
      </div>
      <button onClick={() => setSearchOpen(true)}
        className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm text-slate-400 transition hover:border-slate-300 hover:text-slate-600">
        <Search className="h-4 w-4" /> <span className="flex-1 text-left">Search…</span>
        <kbd className="rounded border border-slate-200 bg-white px-1.5 text-[11px] font-medium text-slate-500">⌘K</kbd>
      </button>
      <div className="thin-scroll flex-1 overflow-y-auto px-3 pb-3">
        {p.groups.map((g) => {
          const items = p.nav.filter((n) => n.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="mt-3">
              <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">{g}</div>
              {items.map((n) => {
                const Icon = ICONS[n.icon as keyof typeof ICONS] ?? LayoutDashboard;
                const href = base + n.href;
                const on = active === href;
                return (
                  <NavLink key={n.href} href={href}
                    className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition ${on ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}>
                    <Icon className={`h-4 w-4 ${on ? "text-brand-600" : "text-slate-400 group-hover:text-slate-600"}`} /> {n.label}
                  </NavLink>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="border-t border-slate-100 px-4 py-3 text-[11px] text-slate-400">corpgroup.com</div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <SessionGuard userId={p.userId} />
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-slate-200 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 shadow-xl">
            <button onClick={() => setOpen(false)} className="absolute right-3 top-3 z-10 rounded-md p-1 text-slate-500 hover:bg-slate-100" aria-label="Close menu"><X className="h-5 w-5" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur sm:px-6">
        <button onClick={() => setOpen(true)} className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="hidden truncate text-slate-500 sm:inline">{p.companyName}</span>
          {current && <><span className="hidden text-slate-300 sm:inline">/</span><span className="truncate font-medium text-slate-900">{current.label}</span></>}
        </div>
        <div className="flex-1" />
        <button onClick={() => setSearchOpen(true)} className="rounded-full p-2 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Search"><Search className="h-5 w-5" /></button>
        <Link href={`${base}notifications`} className="relative rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800" aria-label="Notifications">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-rose-600 px-1 text-center text-[10px] font-semibold leading-[18px] text-white ring-2 ring-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Link>
        <div className="relative">
          <button onClick={() => setMenu((m) => !m)} className="flex items-center gap-2 rounded-full p-0.5 pr-2 transition hover:bg-slate-100" aria-label="Account menu">
            <Avatar name={p.userName} size={30} />
            <span className="hidden max-w-36 truncate text-sm font-medium text-slate-700 sm:block">{p.userName}</span>
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
              <div className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-(--shadow-pop)">
                <div className="border-b border-slate-100 px-3 pb-2.5 pt-2">
                  <div className="truncate text-sm font-semibold text-slate-900">{p.userName}</div>
                  <div className="truncate text-xs text-slate-500">{p.userEmail}</div>
                </div>
                <Link href={`${base}profile`} className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><UserCircle className="h-4 w-4 text-slate-400" /> My profile</Link>
                <Link href="/account" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><KeyRound className="h-4 w-4 text-slate-400" /> Account & security</Link>
                {p.canAddCompany && <Link href="/admin" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"><ShieldCheck className="h-4 w-4 text-brand-500" /> Super Admin console</Link>}
                <Link href={`${base}notifications?tab=preferences`} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><Bell className="h-4 w-4 text-slate-400" /> Notification settings</Link>
                <form action={p.logout} className="mt-1 border-t border-slate-100 pt-1">
                  <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><LogOut className="h-4 w-4 text-slate-400" /> Sign out</button>
                </form>
              </div>
            </>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">{p.children}</main>
      {searchOpen && <SearchPalette companyId={p.companyId} nav={p.nav.map((n) => ({ ...n, href: base + n.href }))} onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

// ⌘K palette: jump to any page, or search employees, projects, tasks and messages
function SearchPalette({ companyId, nav, onClose }: { companyId: string; nav: { href: string; label: string }[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?company=${companyId}&q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then((r) => r.json()).then((d) => { setHits(d.results ?? []); setSel(0); }).catch(() => {});
    }, 180);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, companyId]);

  const pages: Hit[] = nav.filter((n) => n.label.toLowerCase().includes(q.toLowerCase()))
    .map((n) => ({ type: "Go to", title: n.label, sub: "", href: n.href }));
  const all = q.trim().length >= 2 ? [...pages.slice(0, 3), ...hits] : pages;
  const go = (h?: Hit) => { if (h) { onClose(); router.push(h.href); } };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 px-4 pt-[12vh] backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-(--shadow-pop)" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-slate-100 px-4">
          <Search className="h-4 w-4 text-slate-400" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, projects, tasks, messages…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, all.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter") go(all[sel]);
            }} />
          <kbd className="rounded border border-slate-200 px-1.5 text-[11px] text-slate-500">Esc</kbd>
        </div>
        <ul className="thin-scroll max-h-[50vh] overflow-y-auto p-1.5">
          {all.map((h, i) => (
            <li key={`${h.type}-${h.href}`}>
              <button onMouseEnter={() => setSel(i)} onClick={() => go(h)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${i === sel ? "bg-brand-50" : ""}`}>
                <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">{h.type}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-900">{h.title}</span>
                  {h.sub && <span className="block truncate text-xs capitalize text-slate-500">{h.sub}</span>}
                </span>
                {i === sel && <CornerDownLeft className="h-3.5 w-3.5 text-slate-400" />}
              </button>
            </li>
          ))}
          {!all.length && <li className="px-3 py-8 text-center text-sm text-slate-500">{q.length < 2 ? "Type to search." : "No results."}</li>}
        </ul>
      </div>
    </div>
  );
}
