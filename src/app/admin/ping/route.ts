import { NextResponse } from "next/server";

// Keep-alive for the admin portal: the middleware renews the activity stamp on every /admin request,
// so the console calls this while someone is using it (typing, clicking, scrolling) without saving.
export function GET() {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
