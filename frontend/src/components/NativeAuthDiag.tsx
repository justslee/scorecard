"use client";

/**
 * NativeAuthDiag — on-screen auth diagnostic panel for on-device validation.
 *
 * Rendered on the sign-in screen ONLY when:
 *   - Capacitor.isNativePlatform() is true  (TestFlight / device build), OR
 *   - NEXT_PUBLIC_AUTH_DIAG=1 is set in the build env (web debug override).
 *
 * This component must be imported via dynamic(() => ..., { ssr: false })
 * because it calls useAuth() which requires a live <ClerkProvider> — not
 * available during Next.js static-export prerendering.
 *
 * ── Fields ──────────────────────────────────────────────────────────────────
 *  loaded        Clerk JS initialised (true within ~1 s of app open)
 *  signed        isSignedIn from useAuth(); flips true after successful sign-in
 *  native-sent   _is_native=1 was appended to at least one FAPI request URL
 *                  false → AuthProvider hooks not firing; check module load order
 *  auth-hdr      Authorization response header was readable on the last FAPI call
 *                  true  → JWT captured and saved to Preferences (correct!)
 *                  false → header missing/blocked → CORS issue; verify
 *                          CapacitorHttp:enabled in capacitor.config AND that
 *                          `npx cap sync` was run after that change
 *                  —     → no response observed yet
 *  tok           A saved JWT was found in Preferences at startup (cold-start
 *                restore); false on the very first ever sign-in (no saved token)
 *  napi          Clerk Native API dashboard status:
 *                  true  = no native_api_disabled error received (all good)
 *                  false = DISABLED → enable at:
 *                    https://dashboard.clerk.com/last-active?path=native-applications
 *  origin        window.location.origin for the current WebView context
 *  path          Last FAPI path intercepted by the before-request hook
 *  err           Last error from FAPI hooks; absent when all is well
 *
 * ── Expected "everything OK" readout after a successful sign-in ─────────────
 *  loaded:       true
 *  signed:       true          ← the key result
 *  native-sent:  true          ← hook fired
 *  auth-hdr:     true          ← JWT captured from response header
 *  tok:          true          ← (after cold restart with saved token)
 *  napi:         true          ← no native_api_disabled error
 *  origin:       capacitor://localhost  (or https://localhost)
 *  err:          —
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Tap "Copy" to write the full diagnostic text to the clipboard so you can
 * paste it directly into a conversation without re-typing the values.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { Capacitor } from "@capacitor/core";
import { T } from "@/components/yardage/tokens";
import { getAuthDiag, subscribeAuthDiag, type AuthDiagState } from "@/lib/auth-diag";

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
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-render whenever the async FAPI hooks update the diagnostic state.
  useEffect(() => subscribeAuthDiag(() => setDiag({ ...getAuthDiag() })), []);

  // Mirror the Clerk-derived fields (loaded / signed) to the console so the
  // full auth readout — including isLoaded/isSignedIn, which come from useAuth()
  // rather than the FAPI-hook store — is readable from the native log stream.
  // This is how new builds are validated in the simulator without the owner.
  useEffect(() => {
    console.log(
      `[authdiag] loaded=${isLoaded} signed=${isSignedIn ?? false} ` +
        `native-sent=${diag.isNativeSent} ` +
        `auth-hdr=${diag.authHeaderReceived === null ? "—" : diag.authHeaderReceived} ` +
        `tok=${diag.tokenRestored} napi=${!diag.nativeApiDisabled}`,
    );
  }, [isLoaded, isSignedIn, diag]);

  const isNative = Capacitor.isNativePlatform();
  const authDiagEnabled = process.env.NEXT_PUBLIC_AUTH_DIAG === "1";

  const origin = typeof window !== "undefined" ? window.location.origin : "?";

  // ── Build the display rows (computed before the early-return guard) ────────
  const authHdrDisplay =
    diag.authHeaderReceived === null ? "—" : String(diag.authHeaderReceived);

  const rows: Array<[string, string, boolean]> = [
    // [label, value, isError]
    ["loaded",       String(isLoaded),                 false],
    ["signed",       String(isSignedIn ?? false),       false],
    ["native-sent",  String(diag.isNativeSent),         false],
    ["auth-hdr",     authHdrDisplay,                    diag.authHeaderReceived === false],
    ["tok",          String(diag.tokenRestored),         false],
    ["napi",         String(!diag.nativeApiDisabled),   diag.nativeApiDisabled],
    ["origin",       origin,                            false],
    ...(diag.lastFapiPath
      ? ([["path", diag.lastFapiPath, false]] as Array<[string, string, boolean]>)
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
      ...rows.map(([label, value]) => `  ${label.padEnd(12)} ${value}`),
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
  if (!isNative && !authDiagEnabled) return null;

  // ── Render ────────────────────────────────────────────────────────────────
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
        // Container is interactive so the copy button is tappable.
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
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: COLOR.label,
          }}
        >
          Auth diag
        </span>

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
              minWidth: 90,
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
