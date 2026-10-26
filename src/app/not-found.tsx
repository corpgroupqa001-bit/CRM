import Link from "next/link";
import { SearchX } from "lucide-react";

export const metadata = { title: "Page not found" };

// Any URL that doesn't exist, in the app's own style (instead of the framework's bare 404 screen).
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
      <div className="card max-w-md p-8 text-center">
        <span className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500"><SearchX className="h-6 w-6" /></span>
        <h1 className="text-xl font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">The link may be wrong, or the page was moved or removed.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/" className="btn-primary">Go to my workspace</Link>
          <Link href="/login" className="btn-ghost">Sign in</Link>
        </div>
      </div>
    </main>
  );
}
