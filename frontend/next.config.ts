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
    ];
  },
};

export default nextConfig;
