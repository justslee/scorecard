import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.looperapp.app",
  appName: "Looper",
  // The Next.js static export (`output: 'export'`) lands here.
  webDir: "out",
  server: {
    // We REQUEST `https` here, but on iOS the actual runtime WebView origin
    // is `capacitor://localhost` — this config has never produced
    // https://localhost on iOS (comment-only correction, P0 login-blocked
    // fix, specs/p0-login-blocked-plan.md §3; do NOT change iosScheme itself,
    // that's out of scope for this fix — high blast radius, see §4).
    // Capacitor iOS rejects a requested scheme when
    // `WKWebView.handlesURLScheme(scheme)` is already true for it, which is
    // the case for `https` — so it silently falls back to the framework
    // default, `capacitor` (CAPInstanceDescriptor.swift:167-175,
    // InstanceDescriptorDefaults.scheme). Confirmed three ways: the sim
    // launch log ("Loading app at capacitor://localhost"), the on-screen
    // origin readout, and the framework binary. This has been the real
    // origin through ALL history, including builds where native auth was
    // verified green end-to-end — Clerk's allowed_origins includes both
    // https://localhost and capacitor://localhost, and both are in the
    // backend CORS allow-list (backend/app/main.py).
    iosScheme: "https",
  },
  plugins: {
    // Patch document.cookie to use the native WKHTTPCookieStore on iOS
    // (and CookieManager on Android). Without this, cookies set by a
    // cross-origin domain (e.g. clerk.looperapp.org) land in the WKWebView's
    // isolated storage and are silently dropped by ITP — regardless of
    // whether the webview origin is capacitor://localhost (the real iOS
    // origin, see server.iosScheme above) or https://localhost. The native
    // cookie store persists across webview reloads and respects the
    // WKAppBoundDomains allowlist in Info.plist.
    CapacitorCookies: {
      enabled: true,
    },
    // Route all window.fetch / XHR through iOS's native NSURLSession instead
    // of WKWebView's JS fetch. This bypasses browser-level CORS enforcement,
    // so native HTTP reads ALL response headers directly, including the
    // "authorization" header that Clerk's FAPI returns in native token mode
    // (_is_native=1) — without this, browser CORS blocks reading
    // non-safelisted response headers from cross-origin FAPI responses
    // (capacitor:// → clerk.looperapp.org), so response.headers.get
    // ("authorization") always returns null even when the header IS present.
    // CORRECTION (P0 login-blocked fix, specs/p0-login-blocked-plan.md §3):
    // FAPI actually returns `access-control-expose-headers: Authorization,
    // X-Country`, so a standard CORS response WOULD already expose the
    // authorization header to browser fetch — header-readability is
    // therefore NOT the sole reason CapacitorHttp exists here. It remains
    // valuable for the other stated benefit (below: disabling CORS preflight
    // for the authorization request header) and as the mechanism actually
    // proven working end-to-end; do NOT disable it in this P0.
    // With this enabled, the FAPI authorization response header IS readable,
    // the JWT is stored via the native token store, and every subsequent
    // request sends it back in the authorization request header → Clerk
    // authenticates the session. CapacitorHttp is a built-in Capacitor 4+
    // plugin in @capacitor/core.
    // NOTE: also disables CORS preflight for non-simple request headers
    // (e.g. our "authorization" request header), which is safe here because
    // we're communicating only with Clerk FAPI and the backend (both controlled).
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
