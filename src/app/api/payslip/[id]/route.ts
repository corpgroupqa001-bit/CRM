import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/guard";
import { renderPayslipPdf } from "@/lib/payslip-pdf";

export const runtime = "nodejs";

// Payslip PDF, generated on demand (NFR-13). RLS decides who may read it.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireApiUser();
  if (auth.error) return auth.error;
  const { supabase } = auth;
  try {
    const { pdf } = await renderPayslipPdf(supabase, id);
    return new NextResponse(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="payslip-${id.slice(0, 8)}.pdf"`, "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Payslip not found" }, { status: 404 });
  }
}
