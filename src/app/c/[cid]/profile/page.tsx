import { redirect } from "next/navigation";
import { getCtx } from "@/lib/context";

export default async function MyProfile({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const { employee } = await getCtx(cid);
  redirect(employee ? `/c/${cid}/employees/${employee.id}` : `/c/${cid}/dashboard`);
}
