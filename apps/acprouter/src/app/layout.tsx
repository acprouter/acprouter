import type { Metadata } from "next";
import "./global.css";

export const metadata: Metadata = {
  title: "ACP Router",
  description: "A gateway that locally-hosted ACP agents dial out to.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
