"use client";
import { useEffect, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Single-series charts: one brand hue (≥3:1 on the card in both themes), thin marks, recessive grid,
// text in ink colours, and a hover tooltip on every chart. The card title names the series.
// SVG attributes can't read CSS variables, so the palette follows the theme here.
const LIGHT = { series: "#4f46e5", ink: "#5b6678", ink1: "#334155", grid: "#eef0f3", cursor: "#cbd5e1", band: "#f1f5f9", dot: "#ffffff" };
const DARK = { series: "#818cf8", ink: "#8a93a6", ink1: "#c3cad6", grid: "#1f2737", cursor: "#3b4558", band: "#1a2130", dot: "#141a26" };

function usePalette() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    const on = (e: Event) => setDark((e as CustomEvent<string>).detail === "dark");
    window.addEventListener("cg-theme", on);
    return () => window.removeEventListener("cg-theme", on);
  }, []);
  return dark ? DARK : LIGHT;
}

function Tip({ active, payload, label, unit, color }: { active?: boolean; payload?: { value: number }[]; label?: string; unit: string; color: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-surface px-3 py-2 text-xs shadow-(--shadow-pop)">
      <div className="font-medium text-slate-900">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-slate-600">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="tabular-nums">{payload[0].value}{unit}</span>
      </div>
    </div>
  );
}

/** Present % per day (area + 2px line, crosshair tooltip) */
export function AttendanceTrend({ data }: { data: { day: string; pct: number; present: number; total: number }[] }) {
  const c = usePalette();
  return (
    <div className="h-56" role="img" aria-label={`Attendance over the last ${data.length} days`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="att" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.series} stopOpacity={0.18} />
              <stop offset="100%" stopColor={c.series} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={c.grid} />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: c.ink }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tick={{ fontSize: 11, fill: c.ink }} tickLine={false} axisLine={false} unit="%" />
          <Tooltip content={<Tip unit="% present" color={c.series} />} cursor={{ stroke: c.cursor, strokeWidth: 1 }} />
          <Area type="monotone" dataKey="pct" stroke={c.series} strokeWidth={2} fill="url(#att)"
            activeDot={{ r: 4, stroke: c.dot, strokeWidth: 2, fill: c.series }} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Headcount by department (horizontal bars, sorted, 4px rounded data-ends) */
export function HeadcountBars({ data }: { data: { name: string; count: number }[] }) {
  const c = usePalette();
  const h = Math.max(120, data.length * 34 + 10);
  return (
    <div style={{ height: h }} role="img" aria-label="Headcount by department">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 28, bottom: 0, left: 0 }} barCategoryGap={8}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12, fill: c.ink1 }} tickLine={false} axisLine={false} />
          <Tooltip content={<Tip unit=" people" color={c.series} />} cursor={{ fill: c.band }} />
          <Bar dataKey="count" fill={c.series} radius={[0, 4, 4, 0]} maxBarSize={18}
            label={{ position: "right", fontSize: 11, fill: c.ink }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
