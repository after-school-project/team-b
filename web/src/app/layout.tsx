import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "After School Project",
  description: "学校・在校生・卒業生をつなぐコミュニティ",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
