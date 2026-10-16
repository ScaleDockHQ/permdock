import type { ReactNode } from "react";

import { RootDocument, rootMetadata } from "@/components/site/root-document";

import "./globals.css";

// Every page prerenders in full; a request-time read fails the build.
export const ensureStatic = "navigation";

export const metadata = rootMetadata;

export default function Layout({ children }: { children: ReactNode }) {
  return <RootDocument>{children}</RootDocument>;
}
