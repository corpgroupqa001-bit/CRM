"use client";
import { Printer } from "lucide-react";

/** X-03 / ATT-16 "PDF" export: the browser's print dialog with the app chrome hidden (Save as PDF). */
export function PrintButton({ label = "PDF" }: { label?: string }) {
  return <button type="button" onClick={() => window.print()} className="btn-secondary no-print"><Printer className="h-4 w-4" /> {label}</button>;
}
