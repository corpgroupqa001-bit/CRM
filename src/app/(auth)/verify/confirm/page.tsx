import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { verifyLink } from "../../actions";

export const metadata = { title: "Verify your email" };

const ACTION: Record<string, string> = {
  signup: "Verify email and create my account", login: "Sign me in", reset: "Verify and reset my password",
  invite: "Verify and activate my account", change_email: "Confirm my new email",
};

// Opened from the "Verify email" button in the email. Nothing happens until the user presses the
// button, so link scanners in mail clients can't consume the one-time token.
export default async function ConfirmLink({ searchParams }: { searchParams: Promise<{ email?: string; purpose?: string; token?: string; next?: string }> }) {
  const { email = "", purpose = "", token = "", next = "" } = await searchParams;
  if (!email || !token || !ACTION[purpose]) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">This link is incomplete</h1>
        <p className="mt-2 text-sm text-slate-500">Open the newest email again, or enter the 6-digit code instead.</p>
        <Link href="/login" className="btn-secondary mt-5 w-full">Back to sign in</Link>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Verify your email</h1>
      <p className="mt-1 text-sm text-slate-500">Confirm that <span className="font-medium text-slate-700">{email}</span> is your address.</p>
      <ActionForm action={verifyLink} className="mt-5 space-y-4">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="purpose" value={purpose} />
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="next" value={next} />
        <SubmitButton className="btn-primary w-full" pendingText="Verifying…">{ACTION[purpose]}</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm">
        <Link href={`/verify?${new URLSearchParams({ email, purpose, ...(next ? { next } : {}) })}`} className="text-slate-500 hover:underline">Enter the code instead</Link>
      </p>
    </>
  );
}
