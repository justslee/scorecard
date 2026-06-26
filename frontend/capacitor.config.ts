import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.looperapp.app",
  appName: "Looper",
  // The Next.js static export (`output: 'export'`) lands here.
  webDir: "out",
  server: {
    // WebView origin is capacitor://localhost — already in the backend CORS
    // allow-list (backend/app/main.py _allowed_origins).
    iosScheme: "capacitor",
  },
};

export default config;
