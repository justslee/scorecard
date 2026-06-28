"use client";

import { Show, UserButton } from "@clerk/react";
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
      <Show when="signed-in">
        <UserButton
          appearance={{
            elements: {
              avatarBox: "w-8 h-8",
            },
          }}
        />
      </Show>
      <Show when="signed-out">
        <Link
          href="/sign-in"
          className="btn btn-secondary text-sm flex items-center gap-2"
        >
          <LogIn className="h-4 w-4" />
          Sign In
        </Link>
      </Show>
    </>
  );
}
