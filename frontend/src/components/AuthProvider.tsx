"use client";

import { ClerkProvider } from "@clerk/clerk-react";
import { ReactNode } from "react";
import ClerkTokenBridge from "@/components/ClerkTokenBridge";

const clerkAppearance = {
  variables: {
    colorPrimary: "#10b981",
    colorBackground: "#18181b",
    colorInputBackground: "#27272a",
    colorInputText: "#fafafa",
    colorText: "#fafafa",
    colorTextSecondary: "#a1a1aa",
  },
  elements: {
    formButtonPrimary: "bg-emerald-500 hover:bg-emerald-600",
    card: "bg-zinc-900 border border-zinc-800",
    headerTitle: "text-white",
    headerSubtitle: "text-zinc-400",
    socialButtonsBlockButton: "bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-white",
    formFieldLabel: "text-zinc-300",
    formFieldInput: "bg-zinc-800 border-zinc-700 text-white",
    footerActionLink: "text-emerald-500 hover:text-emerald-400",
    identityPreviewText: "text-white",
    identityPreviewEditButton: "text-emerald-400",
  },
};

export default function AuthProvider({ children }: { children: ReactNode }) {
  // Check if Clerk is configured
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!publishableKey) {
    // Return children without Clerk wrapper when not configured
    return <>{children}</>;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} appearance={clerkAppearance}>
      {/* Bridge registers useAuth().getToken into the module singleton so
          non-component code (api.ts / deepgram.ts) can fetch JWTs without
          relying on window.Clerk (which doesn't hydrate on capacitor://). */}
      <ClerkTokenBridge />
      {children}
    </ClerkProvider>
  );
}
