import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR lets a production build sit next to a running dev server (`.next` stays dev's)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@react-pdf/renderer"],
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },   // documents and chat files up to 50 MB
    // keep visited pages in the browser's router cache briefly, so going back to a page or tab is
    // instant. Any server action that changes data calls revalidatePath, which clears it at once.
    staleTimes: { dynamic: 30, static: 120 },
  },
};

export default nextConfig;
