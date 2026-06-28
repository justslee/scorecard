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
    // Route all window.fetch / XHR through iOS's native NSURLSession instead
    // of WKWebView's JS fetch. This bypasses browser-level CORS enforcement:
    // native HTTP reads ALL response headers directly, including the
    // "authorization" header that Clerk's FAPI returns in native token mode
    // (_is_native=1). Without this, browser CORS blocks reading non-safelisted
    // response headers from cross-origin FAPI responses (capacitor:// →
    // clerk.looperapp.org), so response.headers.get("authorization") always
    // returns null even when the header IS present — and the JWT is never saved.
    // With this enabled, the FAPI authorization response header IS readable,
    // the JWT is stored to Preferences, and every subsequent request sends it
    // back in the authorization request header → Clerk authenticates the session.
    // CapacitorHttp is a built-in Capacitor 4+ plugin in @capacitor/core.
    // NOTE: also disables CORS preflight for non-simple request headers
    // (e.g. our "authorization" request header), which is safe here because
    // we're communicating only with Clerk FAPI and the backend (both controlled).
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
