import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { getCtx } from "@/lib/context";
import { ROLE_LABEL } from "@/lib/rbac";
import { Empty } from "@/components/ui";

export const metadata = { title: "Access denied" };

// Shown when someone opens a page their role does not allow (direct URL, old bookmark, shared link).
export default async function Denied({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const { role } = await getCtx(cid);
  return (
    <Empty title="You don't have access to this page" icon={ShieldAlert}
      action={<Link href={`/c/${cid}/dashboard`} className="btn-primary">Back to dashboard</Link>}>
      Your role here is <b>{ROLE_LABEL[role]}</b>, which doesn&apos;t include this area. If you need it for your work, ask your company&apos;s Owner or the Admin.
    </Empty>
  );
}
