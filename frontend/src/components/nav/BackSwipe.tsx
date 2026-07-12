'use client';

// The global left-edge swipe-back detector (specs/universal-swipe-back-plan.md).
//
// Mounted ONCE in app/layout.tsx, beside FloatingTabBar/CaddieOrb. Renders
// null — it only attaches document-level touch listeners and calls
// `router.back()` on a committed edge swipe, everywhere `shouldEnableBackSwipe`
// allows (i.e. everywhere except the in-round hole page and /map/course,
// which own left-edge horizontal touches for their own purposes).
//
// Touch events, not pointer events, deliberately: framer-motion drags
// (SwipeableRow, the round paper fallback, sheets) run on pointer events and
// use pointer capture, so a raw touch listener observes the same finger
// without ever being retargeted or stopped by framer's capture/stopPropagation.
// Capture phase + passive:true mirrors the proven RoundPageClient hole-swipe
// implementation (~L1802-1819) — this detector NEVER calls preventDefault(),
// so native scrolling and every other gesture stay untouched.
import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { haptic } from '@/lib/haptics';
import { normalizePath } from './shouldShowTabBar';
import { shouldEnableBackSwipe } from './shouldEnableBackSwipe';
import {
  decideBackSwipe,
  isDisqualified,
  isEdgeStart,
  readSafeAreaLeft,
  REFIRE_LOCKOUT_MS,
  type BackSwipeSample,
} from './backSwipeGesture';

interface TrackedTouch {
  startX: number;
  startY: number;
  t: number;
}

export default function BackSwipe() {
  const pathname = usePathname();
  const router = useRouter();

  // Live values read inside the once-mounted listeners via refs.
  const pathnameRef = useRef(pathname);
  const routerRef = useRef(router);
  const trackingRef = useRef<TrackedTouch | null>(null);
  const lastFiredRef = useRef(0);

  // Session navigation-depth counter (§6) — window.history.length is a dead
  // end for a single-document static export (it counts the initial document,
  // never decrements on back, and inflates on push-after-back). This counts
  // client-side pushes since app boot instead: Capacitor always cold-boots
  // the shell at the exported entry document (lib/round-url.ts), so depth 0
  // reliably means "nothing in-app behind this page".
  const depthRef = useRef(0);
  const poppedRef = useRef(false);
  const firstPathSeenRef = useRef(false);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  // Known accepted limitation: a *forward* traversal also fires `popstate`
  // and would decrement the counter. The app has no forward affordance (no
  // forward button, and the native iOS forward gesture is never enabled), so
  // in practice this doesn't occur; worst case the fallback below is
  // `router.push('/')` — safe.
  useEffect(() => {
    if (!firstPathSeenRef.current) {
      firstPathSeenRef.current = true;
      return;
    }
    if (poppedRef.current) {
      depthRef.current = Math.max(0, depthRef.current - 1);
      poppedRef.current = false;
    } else {
      depthRef.current += 1;
    }
  }, [pathname]);

  useEffect(() => {
    const onPopState = () => {
      poppedRef.current = true;
    };
    window.addEventListener('popstate', onPopState, { passive: true });
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      trackingRef.current = null;
      if (e.touches.length !== 1) return;
      if (!shouldEnableBackSwipe(pathnameRef.current)) return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-no-backswipe]')) return;
      if (Date.now() - lastFiredRef.current < REFIRE_LOCKOUT_MS) return;

      const touch = e.touches[0];
      const safeAreaLeft = readSafeAreaLeft();
      if (!isEdgeStart(touch.clientX, safeAreaLeft)) return;

      trackingRef.current = { startX: touch.clientX, startY: touch.clientY, t: Date.now() };
    };

    const onTouchMove = (e: TouchEvent) => {
      const tracking = trackingRef.current;
      if (!tracking) return;
      if (e.touches.length !== 1) {
        // Pinch/multi-touch — never a back swipe.
        trackingRef.current = null;
        return;
      }
      const touch = e.touches[0];
      if (isDisqualified(tracking.startX, tracking.startY, touch.clientX, touch.clientY)) {
        trackingRef.current = null;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const tracking = trackingRef.current;
      trackingRef.current = null;
      if (!tracking || e.changedTouches.length !== 1) return;

      const touch = e.changedTouches[0];
      const sample: BackSwipeSample = {
        startX: tracking.startX,
        startY: tracking.startY,
        endX: touch.clientX,
        endY: touch.clientY,
        elapsedMs: Date.now() - tracking.t,
        viewportWidth: window.innerWidth,
        safeAreaLeft: readSafeAreaLeft(),
      };

      if (decideBackSwipe(sample) !== 'back') return;
      // The route may have changed mid-gesture (e.g. a voice action
      // navigated while the finger was down) — re-check before committing.
      if (!shouldEnableBackSwipe(pathnameRef.current)) return;

      const path = normalizePath(pathnameRef.current);
      if (depthRef.current > 0) {
        lastFiredRef.current = Date.now();
        haptic('light');
        routerRef.current.back();
      } else if (path !== '/') {
        // Deep-linked/orphan page with nothing behind it — go home instead
        // of a dead gesture or popping out of the app.
        lastFiredRef.current = Date.now();
        haptic('light');
        routerRef.current.push('/');
      }
      // depthRef.current === 0 && path === '/' → silent no-op, nothing to
      // promise (no haptic, no refire lockout).
    };

    const onTouchCancel = () => {
      trackingRef.current = null;
    };

    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchmove', onTouchMove, { capture: true });
      document.removeEventListener('touchend', onTouchEnd, { capture: true });
      document.removeEventListener('touchcancel', onTouchCancel, { capture: true });
    };
  }, []);

  return null;
}
