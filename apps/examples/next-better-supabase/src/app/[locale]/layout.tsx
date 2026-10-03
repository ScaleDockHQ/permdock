import type { ReactNode } from "react";

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
  readonly params: Promise<{ readonly locale: string }>;
}) {
  const { locale } = await props.params;
  return (
    <html lang={locale}>
      <body>{props.children}</body>
    </html>
  );
}
