/**
 * Bottom-sheet helpers shared by the drag-to-dismiss sheets (CaddieSheet,
 * VoiceRoundSetupRealtime).
 *
 * Two concerns live here:
 *   1. `shouldDismissSheetDrag` — the pure "did this downward drag dismiss?" rule,
 *      extracted so both sheets agree on the threshold and it can be unit-tested.
 *   2. `useBodyScrollLock` — locks the document while a sheet is open so the page
 *      (or the iOS WKWebView's rubber-band scroll) can't move underneath it. This
 *      is what stops a swipe on the grab handle from "falling through" to scroll
 *      the background page when framer-motion doesn't claim the gesture.
 */

import { useEffect } from "react";

/** Default drag-dismiss thresholds (px of downward travel · px/s flick velocity). */
export const SHEET_DISMISS_DISTANCE = 120;
export const SHEET_DISMISS_VELOCITY = 600;

/**
 * Pure rule for a swipe-down-to-dismiss sheet: dismiss when the drag has either
 * travelled far enough OR been flicked fast enough downward. Upward drags
 * (negative offset/velocity) never dismiss.
 */
export function shouldDismissSheetDrag(
  offsetY: number,
  velocityY: number,
  {
    distance = SHEET_DISMISS_DISTANCE,
    velocity = SHEET_DISMISS_VELOCITY,
  }: { distance?: number; velocity?: number } = {},
): boolean {
  return offsetY > distance || velocityY > velocity;
}

/**
 * While `locked` is true, pin <body> in place so the page behind an open sheet
 * cannot scroll or rubber-band (critical in the iOS WKWebView, where
 * `touch-action`/`overscroll-behavior` alone don't fully suppress document
 * bounce). The current scroll position is preserved and restored on unlock.
 *
 * Implemented as position:fixed (rather than overflow:hidden) because only the
 * fixed approach reliably stops WKWebView's document-level rubber-banding.
 */
export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked || typeof document === "undefined") return;

    const body = document.body;
    const scrollY =
      typeof window !== "undefined" ? window.scrollY : 0;

    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
      overscrollBehavior: body.style.overscrollBehavior,
    };

    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";

    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      body.style.overscrollBehavior = prev.overscrollBehavior;
      if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
        try {
          window.scrollTo(0, scrollY);
        } catch {
          /* scrollTo not implemented (e.g. jsdom) — restoring styles is enough */
        }
      }
    };
  }, [locked]);
}
