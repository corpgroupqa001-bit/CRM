// Shown instantly while a page in the company area loads its data. The sidebar and top bar come
// from the layout and stay put; only the content area shows this skeleton.

const Bar = ({ className = "" }: { className?: string }) =>
  <div className={`bg-slate-200/80 ${className.includes("rounded-") ? "" : "rounded-md"} ${className}`} />;

export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading…</span>

      {/* page header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2.5">
          <Bar className="h-3 w-32" />
          <Bar className="h-6 w-56" />
        </div>
        <div className="flex gap-2">
          <Bar className="h-9 w-28 rounded-lg" />
          <Bar className="h-9 w-32 rounded-lg bg-slate-300/70" />
        </div>
      </div>

      {/* stat tiles */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="card p-4">
            <div className="flex items-start justify-between">
              <Bar className="h-3 w-20" />
              <Bar className="h-7 w-7 rounded-lg" />
            </div>
            <Bar className="mt-3 h-7 w-16" />
            <Bar className="mt-2 h-2.5 w-24" />
          </div>
        ))}
      </div>

      {/* main card with a table */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <Bar className="h-4 w-40" />
          <Bar className="h-8 w-24 rounded-lg" />
        </div>
        <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-6">
            {Array.from({ length: 4 }, (_, i) => <Bar key={i} className="h-2.5 w-16" />)}
          </div>
        </div>
        <div className="divide-y divide-slate-100">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="grid grid-cols-[2fr_1fr_1fr_1fr] items-center gap-6 px-4 py-3.5">
              <div className="flex items-center gap-3">
                <Bar className="h-7 w-7 shrink-0 rounded-full" />
                <Bar className={`h-3 ${["w-40", "w-32", "w-44", "w-28"][i % 4]}`} />
              </div>
              <Bar className="h-3 w-20" />
              <Bar className="h-3 w-16" />
              <Bar className="h-5 w-16 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
