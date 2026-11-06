import type { ReactNode } from "react";

import { locale } from "next/root-params";

import { OfflineBadge } from "./offline-badge.tsx";

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
        {props.children}
        <OfflineBadge />
      </body>
    </html>
  );
}
