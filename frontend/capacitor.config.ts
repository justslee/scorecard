import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.looperapp.app",
  appName: "Looper",
  // The Next.js static export (`output: 'export'`) lands here.
  webDir: "out",
  server: {
    // WebView origin is https://localhost. `https` (Capacitor's recommended
    // scheme) is a first-class secure origin: Clerk's session/token handshake
    // works on it, whereas the custom `capacitor://` scheme is treated as a
    // second-class origin and frequently fails to mint session JWTs (the cause
    // of the persistent voice/transcribe 401s). https://localhost is also a
    // proper secure context (required for getUserMedia / the mic).
    // Origin is in the backend CORS allow-list (backend/app/main.py).
    iosScheme: "https",
  },
  plugins: {
    // Patch document.cookie to use the native WKHTTPCookieStore on iOS
    // (and CookieManager on Android). Without this, cookies set by a
    // cross-origin domain (e.g. clerk.looperapp.org) land in the WKWebView's
    // isolated storage and are silently dropped by ITP when the webview origin
    // is https://localhost. The native cookie store persists across webview
    // reloads and respects the WKAppBoundDomains allowlist in Info.plist.
    CapacitorCookies: {
      enabled: true,
    },
  },
};

export default config;
