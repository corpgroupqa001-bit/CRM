"use client";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Single-series charts: one brand hue (validated ≥3:1 on white), thin marks, recessive grid,
// text in ink colours, and a hover tooltip on every chart. The card title names the series.
const SERIES = "#4f46e5";
const INK2 = "#64748b";
const GRID = "#eef0f3";

function Tip({ active, payload, label, unit }: { active?: boolean; payload?: { value: number }[]; label?: string; unit: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-(--shadow-pop)">
      <div className="font-medium text-slate-900">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-slate-600">
        <span className="h-2 w-2 rounded-full" style={{ background: SERIES }} />
        <span className="tabular-nums">{payload[0].value}{unit}</span>
      </div>
    </div>
  );
}

/** Present % per day (area + 2px line, crosshair tooltip) */
export function AttendanceTrend({ data }: { data: { day: string; pct: number; present: number; total: number }[] }) {
  return (
    <div className="h-56" role="img" aria-label={`Attendance over the last ${data.length} days`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="att" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES} stopOpacity={0.18} />
              <stop offset="100%" stopColor={SERIES} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: INK2 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tick={{ fontSize: 11, fill: INK2 }} tickLine={false} axisLine={false} unit="%" />
          <Tooltip content={<Tip unit="% present" />} cursor={{ stroke: "#cbd5e1", strokeWidth: 1 }} />
          <Area type="monotone" dataKey="pct" stroke={SERIES} strokeWidth={2} fill="url(#att)"
            activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: SERIES }} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Headcount by department (horizontal bars, sorted, 4px rounded data-ends) */
export function HeadcountBars({ data }: { data: { name: string; count: number }[] }) {
  const h = Math.max(120, data.length * 34 + 10);
  return (
    <div style={{ height: h }} role="img" aria-label="Headcount by department">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 28, bottom: 0, left: 0 }} barCategoryGap={8}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12, fill: "#334155" }} tickLine={false} axisLine={false} />
          <Tooltip content={<Tip unit=" people" />} cursor={{ fill: "#f1f5f9" }} />
          <Bar dataKey="count" fill={SERIES} radius={[0, 4, 4, 0]} maxBarSize={18}
            label={{ position: "right", fontSize: 11, fill: INK2 }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
