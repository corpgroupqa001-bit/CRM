"use client";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { Badge } from "@/components/ui";
import { fmtDate, label } from "@/lib/format";
import { setTaskStatus } from "./actions";

type Task = { id: string; title: string; status: string; priority: string; due_at: string | null; assignees: string[]; project: string | null };

// TSK-04 Kanban board with drag and drop
export function Board({ cid, tasks, columns }: { cid: string; tasks: Task[]; columns: string[] }) {
  const [optimistic, move] = useOptimistic(tasks, (state, { id, status }: { id: string; status: string }) =>
    state.map((t) => (t.id === id ? { ...t, status } : t)));
  const [, start] = useTransition();
  const now = new Date().toISOString();

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map((col) => {
        const items = optimistic.filter((t) => t.status === col);
        return (
          <div key={col} className="w-72 shrink-0 rounded-xl bg-slate-100/80 p-2"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const id = e.dataTransfer.getData("text/plain");
              if (!id) return;
              start(async () => { move({ id, status: col }); await setTaskStatus(cid, id, col); });
            }}>
            <div className="mb-2 flex items-center justify-between px-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {label(col)}<span className="rounded-full bg-surface px-2 py-0.5">{items.length}</span>
            </div>
            <div className="min-h-24 space-y-2">
              {items.map((t) => (
                <Link key={t.id} href={`/c/${cid}/tasks/${t.id}`} draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                  className="block cursor-grab rounded-lg border border-slate-200 bg-surface p-3 text-sm shadow-sm hover:border-brand-300 active:cursor-grabbing">
                  <div className="font-medium text-slate-800">{t.title}</div>
                  {t.project && <div className="mt-0.5 text-xs text-slate-500">{t.project}</div>}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <Badge value={t.priority} />
                    <span className={`text-xs ${t.due_at && t.due_at < now && t.status !== "done" ? "font-medium text-rose-600" : "text-slate-500"}`}>{t.due_at ? fmtDate(t.due_at) : ""}</span>
                  </div>
                  {t.assignees.length > 0 && <div className="mt-2 truncate text-xs text-slate-500">{t.assignees.join(", ")}</div>}
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
