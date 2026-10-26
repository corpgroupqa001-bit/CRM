import { getCtx, requirePerm } from "@/lib/context";
import { TaxDeclarationView } from "./view";

export const metadata = { title: "Tax declarations" };

// Payroll module: everyone's declarations (Finance / Administrator verify, HR views)
export default async function TaxDeclarations({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ employee?: string }> }) {
  const { cid } = await params;
  requirePerm(await getCtx(cid), "salaries.read");
  return <TaxDeclarationView cid={cid} sp={await searchParams} mode="salaries" />;
}
