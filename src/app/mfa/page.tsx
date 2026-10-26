import { MfaChallenge } from "./challenge";

export const metadata = { title: "Two-factor authentication" };

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next = "/" } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-5">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Enter your code</h1>
        <p className="mt-1.5 text-sm text-slate-500">Open your authenticator app and enter the 6-digit code for corpgroup.com.</p>
        <MfaChallenge next={next.startsWith("/") ? next : "/"} />
      </div>
    </div>
  );
}
