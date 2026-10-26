"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { themeCookie, type Theme } from "@/lib/theme";

function current(): Theme {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Applies the theme at once (no reload) and remembers it for the next visit. */
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.cookie = themeCookie(theme, window.location.protocol === "https:");
  window.dispatchEvent(new CustomEvent("cg-theme", { detail: theme }));
}

function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    setTheme(current());
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener("cg-theme", on);
    return () => window.removeEventListener("cg-theme", on);
  }, []);
  return theme;
}

/** Sun / moon icon button for top bars. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useTheme();
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" onClick={() => applyTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 ${className}`}>
      {theme === "dark" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  );
}

/** Light | Dark segmented control for the profile menu. */
export function ThemeSwitch() {
  const theme = useTheme();
  const opts: { value: Theme; label: string; Icon: typeof Sun }[] = [
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
  ];
  return (
    <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-2 gap-1 rounded-[10px] border border-slate-200 bg-slate-50 p-1">
      {opts.map(({ value, label, Icon }) => (
        <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => applyTheme(value)}
          className={`flex items-center justify-center gap-1.5 rounded-[7px] py-1.5 text-[13px] font-medium transition ${theme === value ? "bg-surface text-slate-900 shadow-(--shadow-card)" : "text-slate-500 hover:text-slate-800"}`}>
          <Icon className="h-3.5 w-3.5" /> {label}
        </button>
      ))}
    </div>
  );
}
