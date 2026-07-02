/**
 * Haptic feedback utilities for mobile
 * Native @capacitor/haptics on device (iOS WKWebView ignores navigator.vibrate,
 * so the plugin is the only path that actually taps on iPhone); falls back to
 * the Vibration API (Android web) and no-ops everywhere else.
 */

type HapticPattern = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'celebration';

// Vibration patterns in milliseconds [vibrate, pause, vibrate, pause, ...]
const patterns: Record<HapticPattern, number | number[]> = {
  light: 10,
  medium: 25,
  heavy: 50,
  success: [10, 50, 20],
  warning: [30, 50, 30],
  error: [50, 30, 50, 30, 50],
  celebration: [10, 30, 10, 30, 20, 50, 30, 50, 50, 100, 100], // Festive!
};

/**
 * Trigger haptic feedback. Fire-and-forget: never throws, never awaited.
 */
export function haptic(pattern: HapticPattern = 'light'): void {
  // Native path — the only one that works inside the iOS app shell.
  import('@capacitor/haptics')
    .then(({ Haptics, ImpactStyle, NotificationType }) => {
      switch (pattern) {
        case 'light':
          return Haptics.impact({ style: ImpactStyle.Light });
        case 'medium':
          return Haptics.impact({ style: ImpactStyle.Medium });
        case 'heavy':
        case 'celebration':
          return Haptics.impact({ style: ImpactStyle.Heavy });
        case 'success':
          return Haptics.notification({ type: NotificationType.Success });
        case 'warning':
          return Haptics.notification({ type: NotificationType.Warning });
        case 'error':
          return Haptics.notification({ type: NotificationType.Error });
      }
    })
    .catch(() => {
      // Plugin unavailable (plain web) — Vibration API fallback (Android).
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(patterns[pattern]);
        } catch {
          // Silently fail if vibration not supported
        }
      }
    });
}

/**
 * Light tap feedback - for buttons, selections
 */
export function hapticLight(): void {
  haptic('light');
}

/**
 * Medium feedback - for confirmations, toggles
 */
export function hapticMedium(): void {
  haptic('medium');
}

/**
 * Heavy feedback - for important actions
 */
export function hapticHeavy(): void {
  haptic('heavy');
}

/**
 * Success feedback - for completed actions
 */
export function hapticSuccess(): void {
  haptic('success');
}

/**
 * Warning feedback - for caution moments
 */
export function hapticWarning(): void {
  haptic('warning');
}

/**
 * Error feedback - for errors
 */
export function hapticError(): void {
  haptic('error');
}

/**
 * Celebration feedback - for achievements, round completion
 */
export function hapticCelebration(): void {
  haptic('celebration');
}
