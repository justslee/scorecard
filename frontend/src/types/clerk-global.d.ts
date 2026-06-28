// Global `window.Clerk` typing.
//
// clerk-js ships this `declare global` augmentation inside its own .d.ts, which
// used to be pulled in transitively by a runtime `import … from "@clerk/clerk-js"`
// in AuthProvider. That import was removed (it bundled a UI-less Clerk instance
// that white-screened the native build — see AuthProvider.tsx), so we re-declare
// the global here as a TYPE-ONLY reference. `import type` is erased at build time,
// so clerk-js is NOT bundled into the static export — only its types are used.
//
// Consumers: src/lib/api.ts and src/lib/storage-api.ts read window.Clerk as a
// fallback token/session source when the ClerkTokenBridge hook getter is unset.
import type { Clerk } from "@clerk/clerk-js";

declare global {
  interface Window {
    Clerk?: Clerk;
  }
}

export {};
