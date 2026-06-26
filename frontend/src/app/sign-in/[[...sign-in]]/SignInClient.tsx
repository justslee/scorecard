"use client";

import dynamic from "next/dynamic";

// Load the Clerk widget client-only. Under static export the page is prerendered
// with no ClerkProvider (the publishable key is injected at runtime via the build
// env), so rendering <SignIn> at prerender would throw.
const SignIn = dynamic(() => import("@clerk/clerk-react").then((m) => m.SignIn), {
  ssr: false,
});

export default function SignInClient() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Welcome Back</h1>
          <p className="text-zinc-400">Sign in to track your rounds</p>
        </div>
        <SignIn
          routing="hash"
          appearance={{
            elements: {
              rootBox: "mx-auto",
              card: "bg-zinc-900/50 backdrop-blur-xl border border-zinc-800 shadow-2xl",
            },
          }}
        />
      </div>
    </div>
  );
}
