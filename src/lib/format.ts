export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "corpgroup.com";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
export const money = (n: number | string | null | undefined) => inr.format(Number(n ?? 0));
export const money2 = (n: number | string | null | undefined) => inr2.format(Number(n ?? 0));
export const num = (n: number | string | null | undefined, d = 2) =>
  Number(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: d });

export const fmtDate = (d: string | Date | null | undefined) =>
  d ? new Date(typeof d === "string" && d.length === 10 ? d + "T00:00:00" : d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
export const fmtTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";
export const fmtDateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";
export const fmtMonth = (d: string | Date) =>
  new Date(typeof d === "string" ? d.slice(0, 7) + "-01T00:00:00" : d).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
export const minutesToHm = (m: number | null | undefined) => {
  const v = Number(m ?? 0);
  return `${Math.floor(v / 60)}h ${String(v % 60).padStart(2, "0")}m`;
};

/** today's date in India as YYYY-MM-DD */
export const todayIST = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
export const monthStart = (d: string) => d.slice(0, 7) + "-01";

export const label = (s: string | null | undefined) =>
  (s ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n: number) {
  return n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? " " + ones[n % 10] : ""}`;
}
function threeDigits(n: number) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ones[h]} Hundred` : "", r ? twoDigits(r) : ""].filter(Boolean).join(" ");
}
/** Net pay in words, Indian numbering (SAL-20): 28549 → "Rupees Twenty Eight Thousand Five Hundred Forty Nine Only" */
export function rupeesInWords(amount: number): string {
  let n = Math.round(Math.abs(amount));
  if (n === 0) return "Rupees Zero Only";
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return `Rupees ${parts.join(" ")} Only`;
}
