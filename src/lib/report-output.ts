import "server-only";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import type { ReportTable } from "@/lib/attendance-report";
import { reportPdf } from "@/lib/report-pdf";

// Downloads for the export route: Excel, CSV and PDF (X-03).

export type Row = Record<string, string | number | null>;
export type Format = "xlsx" | "csv" | "pdf";
export const format = (v: string | null): Format => (v === "csv" || v === "pdf" ? v : "xlsx");

const headers = (type: string, file: string) => ({ "Content-Type": type, "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "private, no-store" });

export function xlsx(rows: Row[], file: string, sheet = "Sheet1") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ info: "No data" }]), sheet);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(new Uint8Array(buf), { headers: headers("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `${file}.xlsx`) });
}

export function text(body: string, file: string, type = "text/csv") {
  return new NextResponse(body, { headers: headers(`${type}; charset=utf-8`, file) });
}

const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const csv = (rows: Row[]) => {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n");
};

/** a filtered report table in the format asked for; the filters are written into the PDF header */
export async function tableDownload(t: ReportTable, fmt: Format, file: string, company: string, filters: string) {
  if (fmt === "pdf") {
    const buf = await reportPdf(t, company, filters);
    return new NextResponse(new Uint8Array(buf), { headers: headers("application/pdf", `${file}.pdf`) });
  }
  if (fmt === "csv") {
    const lines = [t.columns.map(esc).join(","), ...t.rows.map((r) => r.map(esc).join(","))];
    return text(lines.join("\n"), `${file}.csv`);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[t.title], [filters], [], t.columns, ...t.rows, ...(t.legend ? [[], [t.legend]] : [])]);
  XLSX.utils.book_append_sheet(wb, ws, "Report");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(new Uint8Array(buf), { headers: headers("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `${file}.xlsx`) });
}
