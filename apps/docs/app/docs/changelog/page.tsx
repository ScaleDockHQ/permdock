import type { Metadata } from "next";

import { Changelog } from "@/components/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every PermDock release, newest first.",
};

export default function Page() {
  return <Changelog />;
}
