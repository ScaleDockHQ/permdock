import type { ReactNode } from "react";

import { RootDocument, rootMetadata } from "@/components/root-document";

import "./global.css";

// Every page prerenders in full; a request-time read fails the build.
export const ensureStatic = "navigation";

export const metadata = rootMetadata;

export default function Layout({ children }: { children: ReactNode }) {
  return <RootDocument>{children}</RootDocument>;
}
