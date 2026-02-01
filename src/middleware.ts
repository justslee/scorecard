import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Simple middleware that passes through all requests
// Clerk auth is optional - only active when keys are configured
export default function middleware(request: NextRequest) {
  // Just pass through - auth is handled at component level when Clerk is configured
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
