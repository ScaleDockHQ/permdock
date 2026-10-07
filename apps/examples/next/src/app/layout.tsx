import type { ReactNode } from "react";

import "./globals.css";
import { OfflineBadge } from "./offline-badge.tsx";

export const metadata = {
  title: "PermDock on Next.js 16.3",
  description:
    "Cache Components, Partial Prefetching and instant navigation with permission-gated UI.",
};

export default function RootLayout(props: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-svh font-sans">
        {props.children}
        <OfflineBadge />
      </body>
    </html>
  );
}
