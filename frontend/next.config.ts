import type { NextConfig } from "next";

// Static client: the app is exported to `out/` and wrapped natively (Capacitor).
// It talks only to the FastAPI backend at NEXT_PUBLIC_API_URL via absolute,
// authenticated requests (fetchAPI + Clerk Bearer) — there is no same-origin
// server, so the old rewrites() proxy block is gone.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
