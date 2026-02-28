import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CPAP QuickReport Web",
  description: "Local-first CPAP 90-day report generation for clinical handouts",
  robots: {
    index: false,
    follow: false
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
