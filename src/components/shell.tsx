"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell, Building2, CalendarCheck, Check, ChevronsUpDown, CornerDownLeft, Fingerprint, FolderKanban, IndianRupee,
  LayoutDashboard, ListChecks, LogOut, Megaphone, Menu, MessageSquare, Plane, Receipt, Search, Settings, UserCircle,
  Users, X, KeyRound, ShieldCheck,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/ui";
import { NavLink } from "@/components/nav-link";
import { SessionGuard } from "@/components/session-guard";
import { ThemeSwitch, ThemeToggle } from "@/components/theme-toggle";

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
  /** owners create further companies themselves (BRD COM-01) */
  isOwner?: boolean;
  unread: number;
  /** chats with unread messages in this company, for the Chat menu badge (0048, 0050) */
  chatUnread: number;
  userId: string;
  idleMinutes: number;
  logout: () => Promise<void>;
  children: React.ReactNode;
};

type Hit = { type: string; title: string; sub: string; href: string };
type ChatToast = { id: string; title: string; body: string; href: string };

export function Shell(p: Props) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [menu, setMenu] = useState(false);
  const [unread, setUnread] = useState(p.unread);
  const [chatUnread, setChatUnread] = useState(p.chatUnread);
  const [toasts, setToasts] = useState<ChatToast[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const base = `/c/${p.companyId}/`;

  useEffect(() => setUnread(p.unread), [p.unread]);
  useEffect(() => setChatUnread(p.chatUnread), [p.chatUnread]);
  useEffect(() => { setOpen(false); setMenu(false); setSwitcher(false); }, [path]);

  // Chat menu badge (COMMS-07, decision of 29 Oct): recounted when a message arrives, a chat is opened
  // (its last_read_at moves) or the page changes
  const hasChat = p.nav.some((n) => n.href === "chat");
  const { companyId } = p;
  const recountChat = useCallback(() => {
    if (!hasChat) return;
    createClient().rpc("chat_unread", { p_company: companyId }).then(({ data }) => { if (typeof data === "number") setChatUnread(data); });
  }, [hasChat, companyId]);
  useEffect(() => { recountChat(); }, [path, recountChat]);
  const pathRef = useRef(path);
  useEffect(() => { pathRef.current = path; }, [path]);

  // live notification count (Supabase Realtime, RLS-filtered); a chat message pops up instead, unless
  // that chat is already open on screen
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`notif-${p.userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${p.userId}` },
        (payload) => {
          const n = payload.new as { id: string; kind?: string; title: string; body: string | null; link: string | null; company_id: string };
          if (n.kind !== "chat") return setUnread((c) => c + 1);
          if (n.company_id !== companyId) return;
          const href = `/c/${companyId}${n.link ?? "/chat"}`;
          if (pathRef.current !== href) {
            setToasts((t) => [...t.filter((x) => x.href !== href), { id: n.id, title: n.title, body: n.body ?? "", href }].slice(-3));
            setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), 6000);
          }
          setTimeout(recountChat, 800);   // after an open chat has marked it read
        })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversation_members", filter: `user_id=eq.${p.userId}` }, () => recountChat());
    // the live connection must carry the signed-in session, or row security hides every row from it; the browser
    // client doesn't hand the session (read from the cookie) to Realtime by itself. One shared client, so every
    // live view on the page (chat, attendance, WFH) gets it too.
    supabase.realtime.setAuth().then(() => ch.subscribe());
    return () => { supabase.removeChannel(ch); };
  }, [p.userId, companyId, recountChat]);

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

  // phone bottom bar: the first four of these the person can open, plus "More" for the full menu
  const has = (h: string) => p.nav.some((n) => n.href === h);
  const quick = ["dashboard", has("attendance") ? "attendance" : "attendance/me", "employees", "tasks", "chat"]
    .filter(has).slice(0, 4).map((h) => p.nav.find((n) => n.href === h)!);

  const sidebar = (
    <nav className="flex h-full flex-col bg-surface" aria-label="Main">
      <Link href={`/c/${p.companyId}/dashboard`} aria-label="Go to dashboard" className="flex items-center gap-2.5 px-4 pb-1 pt-4 text-[15px] font-semibold text-slate-900">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[11px] font-bold text-white">cg</span>
        corpgroup.com
      </Link>
      <div className="relative px-3 pb-2 pt-3">
        <button onClick={() => setSwitcher((s) => !s)} aria-expanded={switcher}
          className="flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-2 text-left transition hover:border-slate-300">
          {p.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.logoUrl} alt="" className="h-8 w-8 rounded-lg object-cover" />
          ) : (
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-hover text-xs font-bold text-white">
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
          <div className="absolute left-3 right-3 top-full z-30 mt-1 rounded-xl border border-slate-200 bg-surface p-1 shadow-(--shadow-pop)">
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Companies</div>
            {p.companies.map((c) => (
              <button key={c.id} onClick={() => router.push(`/c/${c.id}/dashboard`)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-700 hover:bg-slate-100">
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.id === p.companyId && <Check className="h-4 w-4 text-brand-600" />}
              </button>
            ))}
            {p.isMultiOwner && (
              <Link href="/owner" className="mt-1 flex items-center gap-2 border-t border-slate-100 px-2 pb-1.5 pt-2 text-sm text-slate-700 hover:text-slate-900">
                <Building2 className="h-4 w-4" /> All companies overview
              </Link>
            )}
            {(p.isOwner || p.canAddCompany) && <Link href={p.isOwner ? "/owner?new=1" : "/admin"} className="flex items-center gap-2 px-2 py-1.5 text-sm text-brand-700 hover:underline">+ Add a company</Link>}
          </div>
        )}
      </div>
      <button onClick={() => setSearchOpen(true)}
        className="mx-3 mb-1 flex items-center gap-2 rounded-[10px] border border-slate-200 bg-surface px-2.5 py-2 text-sm text-slate-500 transition hover:border-slate-300 hover:text-slate-700">
        <Search className="h-4 w-4" /> <span className="flex-1 text-left">Search…</span>
        <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 text-[11px] font-medium text-slate-500">⌘K</kbd>
      </button>
      <div className="thin-scroll flex-1 overflow-y-auto px-3 pb-4">
        {p.groups.map((g) => {
          const items = p.nav.filter((n) => n.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="mt-4">
              <div className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{g}</div>
              {items.map((n) => {
                const Icon = ICONS[n.icon as keyof typeof ICONS] ?? LayoutDashboard;
                const href = base + n.href;
                const on = active === href;
                return (
                  <NavLink key={n.href} href={href} aria-current={on ? "page" : undefined}
                    className={`group flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-sm font-medium transition ${on ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}>
                    <Icon className={`h-[18px] w-[18px] ${on ? "text-brand-600" : "text-slate-400 group-hover:text-slate-600"}`} /> {n.label}
                    {n.href === "chat" && chatUnread > 0 && (
                      <span className="ml-auto min-w-[20px] rounded-full bg-danger px-1.5 text-center text-[11px] font-semibold leading-5 text-white" aria-label={`${chatUnread} ${chatUnread === 1 ? "chat" : "chats"} with unread messages`}>
                        {chatUnread > 99 ? "99+" : chatUnread}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          );
        })}
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <SessionGuard userId={p.userId} />
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-slate-200 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-scrim backdrop-blur-[1px]" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 shadow-xl">
            <button onClick={() => setOpen(false)} className="absolute right-3 top-3 z-10 rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close menu"><X className="h-5 w-5" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-10 flex h-[60px] items-center gap-1 border-b border-slate-200 bg-surface/90 px-3 backdrop-blur sm:gap-2 sm:px-6">
        <button onClick={() => setOpen(true)} className="hidden h-10 w-10 items-center justify-center rounded-[10px] text-slate-600 hover:bg-slate-100 sm:inline-flex lg:hidden" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
        <div className="flex min-w-0 items-center gap-2 pl-1 text-sm">
          <span className="hidden truncate text-slate-500 sm:inline">{p.companyName}</span>
          {current && <><span className="hidden text-slate-300 sm:inline">/</span><span className="truncate font-semibold text-slate-900">{current.label}</span></>}
        </div>
        <div className="flex-1" />
        <button onClick={() => setSearchOpen(true)} className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Search"><Search className="h-5 w-5" /></button>
        <ThemeToggle />
        <Link href={`${base}notifications`} className="relative inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-800" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-[18px] text-white ring-2 ring-surface">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Link>
        <div className="relative">
          <button onClick={() => setMenu((m) => !m)} aria-expanded={menu} className="ml-1 flex items-center gap-2 rounded-full p-0.5 transition hover:bg-slate-100 sm:pr-2.5" aria-label="Account menu">
            <Avatar name={p.userName} size={32} />
            <span className="hidden max-w-36 truncate text-sm font-medium text-slate-700 sm:block">{p.userName}</span>
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
              <div className="absolute right-0 z-30 mt-2 w-64 rounded-[14px] border border-slate-200 bg-surface p-1.5 shadow-(--shadow-pop)">
                <div className="border-b border-slate-100 px-3 pb-2.5 pt-2">
                  <div className="truncate text-sm font-semibold text-slate-900">{p.userName}</div>
                  <div className="truncate text-xs text-slate-500">{p.userEmail}</div>
                </div>
                <Link href={`${base}profile`} className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><UserCircle className="h-4 w-4 text-slate-400" /> My profile</Link>
                <Link href="/account" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><KeyRound className="h-4 w-4 text-slate-400" /> Account & security</Link>
                {p.canAddCompany && <Link href="/admin" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"><ShieldCheck className="h-4 w-4 text-brand-600" /> Super Admin console</Link>}
                <Link href={`${base}notifications?tab=preferences`} className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><Bell className="h-4 w-4 text-slate-400" /> Notification settings</Link>
                <div className="px-3 pb-1.5 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Appearance</div>
                <div className="px-2 pb-2"><ThemeSwitch /></div>
                <form action={p.logout} className="border-t border-slate-100 pt-1">
                  <button className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><LogOut className="h-4 w-4 text-slate-400" /> Sign out</button>
                </form>
              </div>
            </>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 pb-28 pt-5 sm:px-6 lg:py-8">{p.children}</main>
      <nav aria-label="Quick" className="no-print fixed inset-x-0 bottom-0 z-30 grid border-t border-slate-200 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        style={{ gridTemplateColumns: `repeat(${quick.length + 1}, minmax(0, 1fr))` }}>
        {quick.map((n) => {
          const Icon = ICONS[n.icon as keyof typeof ICONS] ?? LayoutDashboard;
          const href = base + n.href;
          const on = active === href;
          return (
            <NavLink key={n.href} href={href} aria-current={on ? "page" : undefined}
              className={`flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${on ? "text-brand-700" : "text-slate-500"}`}>
              <span className="relative">
                <Icon className="h-[22px] w-[22px]" />
                {n.href === "chat" && chatUnread > 0 && (
                  <span className="absolute -right-2.5 -top-1.5 min-w-[18px] rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-[18px] text-white ring-2 ring-surface" aria-label={`${chatUnread} ${chatUnread === 1 ? "chat" : "chats"} with unread messages`}>
                    {chatUnread > 99 ? "99+" : chatUnread}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate px-1">{n.href === "dashboard" ? "Home" : n.label.replace(/^My /, "")}</span>
            </NavLink>
          );
        })}
        <button onClick={() => setOpen(true)} className="flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium text-slate-500" aria-label="More: open the full menu">
          <Menu className="h-[22px] w-[22px]" /><span>More</span>
        </button>
      </nav>
      {toasts.length > 0 && (
        <div className="no-print fixed right-3 top-[68px] z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 lg:right-6" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="flex items-start gap-3 rounded-[14px] border border-slate-200 bg-surface p-3 shadow-(--shadow-pop)">
              <Link href={t.href} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="flex min-w-0 flex-1 items-start gap-3">
                <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600"><MessageSquare className="h-4 w-4" /></span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-900">{t.title}</span>
                  <span className="block truncate text-sm text-slate-600">{t.body}</span>
                </span>
              </Link>
              <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim px-4 pt-[12vh] backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-surface shadow-(--shadow-pop)" onClick={(e) => e.stopPropagation()}>
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
                <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-500">{h.type}</span>
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
