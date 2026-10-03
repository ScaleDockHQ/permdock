import type { ReactNode } from "react";

import { RootDocument, rootMetadata } from "@/components/root-document";

import "./global.css";

export const metadata = rootMetadata;

export default function Layout({ children }: { children: ReactNode }) {
  return <RootDocument>{children}</RootDocument>;
}
