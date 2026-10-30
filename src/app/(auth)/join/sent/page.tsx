import Link from "next/link";

export const metadata = { title: "Request sent" };

// after an employee signs up with a company code (AUTH-19): nothing to do until it is approved
export default async function JoinSent({ searchParams }: { searchParams: Promise<{ company?: string }> }) {
  const company = (await searchParams).company;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Request sent</h1>
      <p className="mt-3 text-sm text-slate-600">
        Your request to join <b>{company ?? "your company"}</b> is waiting for the Owner or the Admin. You&apos;ll be able to sign in as soon as
        they approve it; each project you asked for is approved separately.
      </p>
      <p className="mt-8 border-t border-slate-100 pt-6 text-sm"><Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">← Back to sign in</Link></p>
    </>
  );
}
