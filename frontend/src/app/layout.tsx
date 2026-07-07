import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Geist, Geist_Mono } from "next/font/google";
import AuthProvider from "@/components/AuthProvider";
import FloatingTabBar from "@/components/nav/FloatingTabBar";
import LooperSheet from "@/components/LooperSheet";
import "./globals.css";

const serif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  display: "swap",
});

const sans = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
  display: "swap",
});

const mono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Looper — The Yardage Book",
  description: "A quiet, voice-first golf companion. Scorecard, caddy, and tee times.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Looper",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#f4f1ea",
  // Required for iOS env(safe-area-inset-*) to resolve to real values instead
  // of 0. Without this the Dynamic Island / status-bar insets are invisible to
  // CSS and every screen's max(14px, env(safe-area-inset-top)) collapses to 14px.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className={`${serif.variable} ${sans.variable} ${mono.variable} antialiased`}>
        <AuthProvider>
          {children}
          <FloatingTabBar />
          <LooperSheet />
        </AuthProvider>
      </body>
    </html>
  );
}
