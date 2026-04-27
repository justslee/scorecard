import type { NextConfig } from "next";

// In production, set BACKEND_URL to your EC2 instance (e.g., https://api.yourdomain.com)
// In development, defaults to localhost:8000
const backendUrl = process.env.BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Proxy caddie + golf API routes to Python backend
      {
        source: "/api/caddie/:path*",
        destination: `${backendUrl}/api/caddie/:path*`,
      },
      {
        source: "/api/golf",
        destination: `${backendUrl}/api/golf`,
      },
      {
        source: "/api/courses/search",
        destination: `${backendUrl}/api/courses/search`,
      },
      {
        source: "/api/courses/search-osm",
        destination: `${backendUrl}/api/courses/search-osm`,
      },
      {
        source: "/api/courses/nearby",
        destination: `${backendUrl}/api/courses/nearby`,
      },
      {
        source: "/api/voice/parse-round-setup",
        destination: `${backendUrl}/api/voice/parse-round-setup`,
      },
      {
        source: "/api/voice/parse-transcript",
        destination: `${backendUrl}/api/voice/parse-transcript`,
      },
      {
        source: "/api/voice/transcribe",
        destination: `${backendUrl}/api/voice/transcribe`,
      },
      // Persistent caddie memory (PR #1) + Realtime ephemeral session mint (PR #2)
      {
        source: "/api/memory/:path*",
        destination: `${backendUrl}/api/memory/:path*`,
      },
      {
        source: "/api/realtime/:path*",
        destination: `${backendUrl}/api/realtime/:path*`,
      },
      // Shot tracking (PR #4)
      {
        source: "/api/shots/:path*",
        destination: `${backendUrl}/api/shots/:path*`,
      },
      {
        source: "/api/shots",
        destination: `${backendUrl}/api/shots`,
      },
      // Pin marking (PR #6) — proxies /api/courses/:id/pins. Note: more specific
      // than the existing /api/courses/search rewrite, must come before any
      // catch-all course rule.
      {
        source: "/api/courses/:courseId/pins",
        destination: `${backendUrl}/api/courses/:courseId/pins`,
      },
    ];
  },
};

export default nextConfig;
