import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Proxy caddie + golf API routes to Python backend
      {
        source: "/api/caddie/:path*",
        destination: "http://localhost:8000/api/caddie/:path*",
      },
      {
        source: "/api/golf",
        destination: "http://localhost:8000/api/golf",
      },
      {
        source: "/api/courses/search",
        destination: "http://localhost:8000/api/courses/search",
      },
      {
        source: "/api/courses/search-osm",
        destination: "http://localhost:8000/api/courses/search-osm",
      },
      {
        source: "/api/courses/nearby",
        destination: "http://localhost:8000/api/courses/nearby",
      },
      {
        source: "/api/voice/parse-round-setup",
        destination: "http://localhost:8000/api/voice/parse-round-setup",
      },
      {
        source: "/api/voice/parse-transcript",
        destination: "http://localhost:8000/api/voice/parse-transcript",
      },
    ];
  },
};

export default nextConfig;
