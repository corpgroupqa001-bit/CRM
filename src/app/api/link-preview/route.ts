import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { requireApiUser } from "@/lib/auth/guard";

export const runtime = "nodejs";

// COMMS-03 link previews. Fetches only public http(s) pages: private, loopback and link-local
// addresses are refused (no SSRF into the server's network), redirects are re-checked,
// and the response is capped in time and size.

function privateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? privateIp(m[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function safeUrl(raw: string) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("bad scheme");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("bad port");
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("blocked host");
  return u;
}

const meta = (html: string, keys: string[]) => {
  for (const k of keys) {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i"))
      ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i"));
    if (m) return m[1].trim();
  }
  return null;
};
const decode = (s: string | null) => s?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">") ?? null;

export async function GET(req: Request) {
  const auth = await requireApiUser();
  if (auth.error) return auth.error;
  try {
    let url = await safeUrl(new URL(req.url).searchParams.get("url") ?? "");
    let res: Response | null = null;
    for (let hop = 0; hop < 3; hop++) {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000), headers: { "user-agent": "corpgroup-link-preview/1.0", accept: "text/html" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = await safeUrl(new URL(res.headers.get("location")!, url).toString()); continue; }
      break;
    }
    if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) return NextResponse.json({ url: url.toString() });
    const reader = res.body!.getReader();
    let html = "";
    while (html.length < 300_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const title = decode(meta(html, ["og:title", "twitter:title"]) ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null);
    const description = decode(meta(html, ["og:description", "twitter:description", "description"]));
    let image = meta(html, ["og:image", "twitter:image"]);
    if (image) { try { image = new URL(image, url).toString(); if (!image.startsWith("https://")) image = null; } catch { image = null; } }
    return NextResponse.json({ url: url.toString(), host: url.hostname, title, description: description?.slice(0, 200), image },
      { headers: { "cache-control": "private, max-age=86400" } });
  } catch {
    return NextResponse.json({ error: "No preview" }, { status: 200 });
  }
}
