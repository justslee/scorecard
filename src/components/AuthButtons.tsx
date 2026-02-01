"use client";

import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { LogIn } from "lucide-react";

export default function AuthButtons() {
  // Check if Clerk is configured
  const isClerkConfigured = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!isClerkConfigured) {
    // Don't show auth buttons when Clerk isn't configured
    return null;
  }

  return (
    <>
      <SignedIn>
        <UserButton
          afterSignOutUrl="/"
          appearance={{
            elements: {
              avatarBox: "w-8 h-8",
            },
          }}
        />
      </SignedIn>
      <SignedOut>
        <Link
          href="/sign-in"
          className="btn btn-secondary text-sm flex items-center gap-2"
        >
          <LogIn className="h-4 w-4" />
          Sign In
        </Link>
      </SignedOut>
    </>
  );
}
