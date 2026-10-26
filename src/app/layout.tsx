import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "corpgroup.com", template: "%s · corpgroup.com" },
  description: "Workforce management: employees, biometric attendance, payroll, tasks and chat.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "corpgroup", statusBarStyle: "default" },
};

export const viewport: Viewport = { themeColor: "#4338ca", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))}`,
          }}
        />
      </body>
    </html>
  );
}
