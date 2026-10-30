import { redirect } from "next/navigation";

// Sign-up approvals moved to one Requests list for all companies (COM-15, 0056)
export default async function Approvals({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  redirect(`/c/${cid}/requests?company=${cid}`);
}
