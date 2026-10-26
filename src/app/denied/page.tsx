import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { logout } from "@/app/(auth)/actions";
import { getUser } from "@/lib/context";

export const metadata = { title: "No access" };

const REASONS: Record<string, string> = {
  not_member: "You aren't a member of this company, or the link is wrong.",
  membership_inactive: "Your access to this company has been switched off by an administrator.",
  employee_inactive: "Your employee record in this company is inactive or you have left, so access has ended.",
  super_admin: "This page is only for the platform Super Admin, and the account you're signed in with isn't one.",
  unavailable: "Access could not be checked right now, so it was refused. If this keeps happening, the database is missing the latest migration.",
};

// Company access refused before the app loads (no membership, disabled, inactive or exited).
export default async function NoAccess({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason = "not_member" } = await searchParams;
  const user = await getUser();
  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <div className="card max-w-md p-8 text-center">
        <span className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600"><ShieldAlert className="h-6 w-6" /></span>
        <h1 className="text-xl font-semibold text-slate-900">No access</h1>
        <p className="mt-2 text-sm text-slate-600">{REASONS[reason] ?? REASONS.not_member}</p>
        {user?.email && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">Signed in as <b className="font-medium text-slate-900">{user.email}</b></p>}
        <p className="mt-3 text-sm text-slate-500">{reason === "super_admin" ? "Sign in with the Super Admin account to open it." : "If this is a mistake, contact your company administrator."}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/" className="btn-secondary">My companies</Link>
          <form action={logout}><button className="btn-ghost">Sign in with another account</button></form>
        </div>
      </div>
    </main>
  );
}
