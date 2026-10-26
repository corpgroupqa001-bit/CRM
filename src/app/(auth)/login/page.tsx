import { CompanySignIn } from "./company-sign-in";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string; next?: string; pending?: string }> }) {
  const sp = await searchParams;
  return <CompanySignIn {...sp} />;
}
