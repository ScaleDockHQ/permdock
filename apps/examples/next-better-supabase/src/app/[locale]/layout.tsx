import type { ReactNode } from "react";

import { locale } from "next/root-params";

import { TooltipProvider } from "@/components/ui/tooltip";

import { OfflineBadge } from "./offline-badge.tsx";
import "./globals.css";

export const metadata = {
  title: "PermDock with better-supabase",
  description:
    "Snapshot-only permission UI over Supabase claims, with RLS deciding the rows.",
};

export function generateStaticParams(): { locale: string }[] {
  return [{ locale: "en" }];
}

export default async function RootLayout(props: {
  readonly children: ReactNode;
}) {
  return (
    <html lang={await locale()}>
      <body>
        <TooltipProvider>{props.children}</TooltipProvider>
        <OfflineBadge />
      </body>
    </html>
  );
}
