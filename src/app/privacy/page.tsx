import Link from "next/link";

export const metadata = { title: "Privacy notice" };

// NFR-06 notice shown at sign-up and activation (consent, purpose limitation, rights)
export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-12 text-slate-700">
      <Link href="/" className="text-sm font-medium text-brand-600 hover:underline">← corpgroup.com</Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-slate-900">Privacy notice</h1>
      <p className="mt-2 text-sm text-slate-500">Under the Digital Personal Data Protection Act, 2023 (India)</p>
      <div className="mt-8 space-y-6 text-[15px] leading-relaxed">
        <section><h2 className="font-semibold text-slate-900">What we collect</h2>
          <p>Your name, contact details, job details, attendance punches (device user IDs, times and, for mobile punches, a selfie and location), leave, salary and statutory details (PAN, Aadhaar, UAN, bank account), work tasks and messages.</p></section>
        <section><h2 className="font-semibold text-slate-900">What we don&apos;t collect</h2>
          <p>We never store fingerprint or face templates. Biometric devices keep those; we receive only a device user ID and the punch time.</p></section>
        <section><h2 className="font-semibold text-slate-900">Why</h2>
          <p>Only to run your employer&apos;s attendance, payroll, statutory filings, tasks and internal communication. Your employer is the data fiduciary; corpgroup.com processes data on their behalf.</p></section>
        <section><h2 className="font-semibold text-slate-900">How it&apos;s protected</h2>
          <p>Data is stored in India (Mumbai region), encrypted at rest. PAN, Aadhaar and bank numbers are additionally encrypted and always shown masked. Each company&apos;s data is isolated from every other company.</p></section>
        <section><h2 className="font-semibold text-slate-900">How long</h2>
          <p>Payroll and attendance records: 8 years, as the law requires. Chat: as set by your employer (2 years by default). Data of closed companies is deleted 90 days after closure.</p></section>
        <section><h2 className="font-semibold text-slate-900">Your rights</h2>
          <p>You can download your data and ask for correction or erasure from <b>Account &amp; security</b> once signed in, or by asking your HR team.</p></section>
      </div>
    </main>
  );
}
