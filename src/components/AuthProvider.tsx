"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { ReactNode } from "react";

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
  const isClerkConfigured = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!isClerkConfigured) {
    // Return children without Clerk wrapper when not configured
    return <>{children}</>;
  }

  return (
    <ClerkProvider appearance={clerkAppearance}>
      {children}
    </ClerkProvider>
  );
}
