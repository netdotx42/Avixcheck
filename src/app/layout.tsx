import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { env, isConfigured } from "@/env";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "AvixCheck", template: "%s · AvixCheck" },
  description: "Every invoice. Checked. Flag supplier invoice discrepancies against purchase orders and agreed prices before payment.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <html lang="en-GB" className={inter.variable}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
  if (env().AUTH_PROVIDER === "clerk" && isConfigured("auth")) {
    const { ClerkProvider } = await import("@clerk/nextjs");
    return (
      <ClerkProvider appearance={{ variables: { colorPrimary: "#2563EB", colorBackground: "#141A23", colorText: "#E5E7EB", colorInputBackground: "#080B10" } }}>
        {body}
      </ClerkProvider>
    );
  }
  return body;
}
