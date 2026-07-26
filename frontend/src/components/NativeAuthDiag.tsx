"use client";

/**
 * NativeAuthDiag — DEV/SIM-ONLY auth diagnostic strip.
 *
 * P0 fix (specs/p0-login-blocked-plan.md): this component used to render on
 * every native build — including TestFlight — because its runtime gate was
 * "native OR opt-in". It shipped as a fixed, full-width, pointerEvents:auto
 * slab over the bottom third of the sign-in screen and occluded the sign-in
 * controls, blocking the owner from logging in. It is now:
 *
 *   1. Excluded from every shipped bundle at BUILD TIME — the dynamic import
 *      in SignInClient.tsx is itself conditional on NEXT_PUBLIC_AUTH_DIAG, so
 *      with the flag unset the component and its strings never reach `out/`
 *      (proven by scripts/assert-no-auth-diag.mjs, run as `postbuild`).
 *   2. Gated a second time here (`if (!authDiagEnabled) return null`) as a
 *      belt-and-suspenders layer — no more "native" runtime arm.
 *   3. Non-occluding by default: renders as a small collapsed chip, not a
 *      fixed slab, so even a flagged dev/sim build never covers the sign-in
 *      form. Tap the chip to expand the full readout; tap again to collapse.
 *
 * This component must be imported via dynamic(() => ..., { ssr: false })
 * because it calls useAuth() which requires a live <ClerkProvider> — not
 * available during Next.js static-export prerendering.
 *
 * ── Fields ──────────────────────────────────────────────────────────────────
 *  loaded            Clerk JS initialised (true within ~1 s of app open)
 *  signed            isSignedIn from useAuth(); flips true after successful sign-in
 *  native-sent       _is_native=1 was appended to at least one FAPI request URL
 *                      false → AuthProvider hooks not firing; check module load order
 *  auth-hdr(/v1/client)
 *                    Authorization response header on the last /v1/client
 *                    response specifically — the only endpoint whose header
 *                    means anything (/v1/environment never carries one, even
 *                    on a fully healthy run). Shown as "<bool> (<status>)".
 *                      true  → JWT captured and saved to the native token store (correct!)
 *                      false → header missing/blocked → CORS issue; verify
 *                              CapacitorHttp:enabled in capacitor.config AND that
 *                              `npx cap sync` was run after that change
 *                      —     → no /v1/client response observed yet
 *  tok               A saved JWT was found in the native token store at startup
 *                    (cold-start restore); false on the very first ever sign-in
 *  napi              Clerk Native API dashboard status:
 *                      true  = no native_api_disabled error received (all good)
 *                      false = DISABLED → enable at:
 *                        https://dashboard.clerk.com/last-active?path=native-applications
 *  origin            window.location.origin for the current WebView context
 *  req-path          Path of the last FAPI REQUEST (before-hook). A request-time
 *                    field — do not read it as describing `resp` below; they can
 *                    be different calls (see auth-diag.ts for why this used to
 *                    manufacture a phantom defect).
 *  resp              Path + status + auth-header presence of the last FAPI
 *                    RESPONSE (after-hook), as one atomic record.
 *  err               Last error from FAPI hooks; absent when all is well
 *
 * ── Expected "everything OK" readout after a successful sign-in ─────────────
 *  loaded:              true
 *  signed:              true          ← the key result
 *  native-sent:         true          ← hook fired
 *  auth-hdr(/v1/client): true (200)   ← JWT captured from the /v1/client response
 *  tok:                 true          ← (after cold restart with saved token)
 *  napi:                true          ← no native_api_disabled error
 *  origin:              capacitor://localhost  (or https://localhost)
 *  err:                 —
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Tap "Copy" to write the full diagnostic text to the clipboard so you can
 * paste it directly into a conversation without re-typing the values.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { T } from "@/components/yardage/tokens";
import { getAuthDiag, subscribeAuthDiag, type AuthDiagState } from "@/lib/auth-diag";

// The only FAPI path whose auth header signals a captured session JWT.
const CLIENT_PATH = "/v1/client";

// ─── Palette (same paper / ink tones used across the app) ─────────────────
const COLOR = {
  bg: "#ece7db",                  // T.paperDeep — calm paper background
  border: "rgba(107,101,88,0.22)",
  label: "#6b6558",               // T.pencil — muted field names
  value: "#1a2a1a",               // T.ink — field values
  valueBad: "#b84a3a",            // T.errorInk — only for clear error states
  copyBtn: "#1a2a1a",             // ink button
  copyBtnTxt: "#f4f1ea",          // paper text on ink button
} as const;

export default function NativeAuthDiag() {
  const { isLoaded, isSignedIn } = useAuth();
  const [diag, setDiag] = useState<AuthDiagState>(getAuthDiag());
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-render whenever the async FAPI hooks update the diagnostic state.
  useEffect(() => subscribeAuthDiag(() => setDiag({ ...getAuthDiag() })), []);

  // The one auth-header value that means anything: the /v1/client response
  // specifically (never the global "last response", which can be any path).
  const clientResponse = diag.responseByPath[CLIENT_PATH] ?? null;
  const authHdrDisplay =
    clientResponse === null
      ? "—"
      : `${clientResponse.authHeaderPresent}${
          clientResponse.status !== null ? ` (${clientResponse.status})` : ""
        }`;

  // Mirror the Clerk-derived fields (loaded / signed) to the console so the
  // full auth readout — including isLoaded/isSignedIn, which come from useAuth()
  // rather than the FAPI-hook store — is readable from the native log stream.
  // This is how new builds are validated in the simulator without the owner.
  useEffect(() => {
    console.log(
      `[authdiag] loaded=${isLoaded} signed=${isSignedIn ?? false} ` +
        `native-sent=${diag.isNativeSent} ` +
        `auth-hdr(${CLIENT_PATH})=${authHdrDisplay} ` +
        `tok=${diag.tokenRestored} napi=${!diag.nativeApiDisabled}`,
    );
  }, [isLoaded, isSignedIn, diag, authHdrDisplay]);

  const authDiagEnabled = process.env.NEXT_PUBLIC_AUTH_DIAG === "1";

  const origin = typeof window !== "undefined" ? window.location.origin : "?";

  const lastResponseDisplay = diag.lastResponse
    ? `${diag.lastResponse.path ?? "?"} status=${diag.lastResponse.status ?? "?"} auth=${diag.lastResponse.authHeaderPresent}`
    : "—";

  // ── Build the display rows (computed before the early-return guard) ────────
  const rows: Array<[string, string, boolean]> = [
    // [label, value, isError]
    ["loaded",                    String(isLoaded),               false],
    ["signed",                    String(isSignedIn ?? false),     false],
    ["native-sent",               String(diag.isNativeSent),       false],
    [`auth-hdr(${CLIENT_PATH})`,  authHdrDisplay,                  clientResponse !== null && !clientResponse.authHeaderPresent],
    ["tok",                       String(diag.tokenRestored),      false],
    ["napi",                      String(!diag.nativeApiDisabled), diag.nativeApiDisabled],
    ["origin",                    origin,                          false],
    ...(diag.lastRequestPath
      ? ([["req-path", diag.lastRequestPath, false]] as Array<[string, string, boolean]>)
      : []),
    ...(diag.lastResponse
      ? ([["resp", lastResponseDisplay, false]] as Array<[string, string, boolean]>)
      : []),
    ...(diag.lastError
      ? ([["err", diag.lastError, true]] as Array<[string, string, boolean]>)
      : []),
  ];

  // ── Copy handler — all hooks must be unconditionally above any return ──────
  // Build a stable cache key from the current row values so useCallback only
  // recreates when the content actually changes.
  const rowsCacheKey = rows.map(r => r.slice(0, 2).join("=")).join("|");
  const handleCopy = useCallback(async () => {
    const text = [
      `Looper Auth Diagnostic  ${new Date().toISOString()}`,
      "",
      ...rows.map(([label, value]) => `  ${label.padEnd(22)} ${value}`),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available in this context; silently ignore.
    }
  // rowsCacheKey changes whenever any row value changes, triggering a new
  // closure so the copied text is always fresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsCacheKey]);

  // ── Early-return guard (all hooks are unconditionally above this) ─────────
  if (!authDiagEnabled) return null;

  // ── Collapsed default: a small chip, never a slab over the sign-in form ───
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        style={{
          position: "fixed",
          top: "max(env(safe-area-inset-top, 0px), 8px)",
          right: 8,
          zIndex: 9999,
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          color: COLOR.label,
          background: COLOR.bg,
          border: `1px solid ${COLOR.border}`,
          borderRadius: 999,
          padding: "4px 10px",
          cursor: "pointer",
          WebkitAppearance: "none",
        }}
      >
        diag
      </button>
    );
  }

  // ── Expanded — full readout, tap the header to collapse again ─────────────
  return (
    <div
      style={{
        position: "fixed",
        // Sits above the home indicator / safe area.
        bottom: "max(env(safe-area-inset-bottom, 0px), 8px)",
        left: 8,
        right: 8,
        padding: "10px 14px 12px",
        fontFamily: T.mono,
        fontSize: 12,
        lineHeight: 1.65,
        color: COLOR.value,
        background: COLOR.bg,
        borderRadius: 4,
        border: `1px solid ${COLOR.border}`,
        boxShadow: "0 1px 4px rgba(26,42,26,0.10)",
        zIndex: 9999,
        // Container is interactive so the copy/collapse controls are tappable.
        pointerEvents: "auto",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <button
          onClick={() => setExpanded(false)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: COLOR.label,
            WebkitAppearance: "none",
          }}
        >
          Auth diag ✕
        </button>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          style={{
            background: COLOR.copyBtn,
            color: COLOR.copyBtnTxt,
            border: "none",
            borderRadius: 2,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 0.6,
            padding: "3px 9px",
            cursor: "pointer",
            WebkitAppearance: "none",
            flexShrink: 0,
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* Divider */}
      <div
        style={{
          borderTop: `1px solid ${COLOR.border}`,
          marginBottom: 7,
        }}
      />

      {/* Diagnostic rows — one field per line */}
      {rows.map(([label, value, isError]) => (
        <div
          key={label}
          style={{
            display: "flex",
            gap: 8,
            color: isError ? COLOR.valueBad : COLOR.value,
          }}
        >
          <span
            style={{
              color: COLOR.label,
              minWidth: 150,
              flexShrink: 0,
              userSelect: "none",
            }}
          >
            {label}
          </span>
          <span
            style={{
              wordBreak: "break-all",
              flex: 1,
            }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}
