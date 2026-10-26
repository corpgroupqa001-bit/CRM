import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { PASSWORD_RULE } from "@/lib/auth/session";
import { setPassword } from "../actions";
import { PasswordInput } from "@/components/password-input";

export const metadata = { title: "Set your password" };

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string; welcome?: string }> }) {
  const { next = "/", reset, welcome } = await searchParams;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{reset ? "Choose a new password" : "Set your password"}</h1>
      <p className="mt-1 text-sm text-slate-500">{welcome ? "Your email is verified. " : ""}{PASSWORD_RULE}</p>
      <ActionForm action={setPassword} className="mt-5 space-y-4">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="reset" value={reset ? "1" : ""} />
        <Field label="New password"><PasswordInput name="password" minLength={8} required autoFocus autoComplete="new-password" /></Field>
        <Field label="Confirm password"><PasswordInput name="confirm" minLength={8} required autoComplete="new-password" /></Field>
        <SubmitButton className="btn-primary w-full" pendingText="Saving…">Save password</SubmitButton>
      </ActionForm>
    </>
  );
}
