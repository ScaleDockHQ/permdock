import type { Metadata } from "next";

import Link from "next/link";

import { DevtoolsPanel } from "@/components/devtools-panel";
import { docsIndex } from "@/lib/shared";

export const metadata: Metadata = {
  title: "Devtools",
  description:
    "Explore PermDock decide outcomes against a canned policy. Not a package export.",
};

export default function DevtoolsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-12">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          <Link href={docsIndex} className="underline">
            Docs
          </Link>
          {" / "}
          <Link href="/docs/getting-started/devtools" className="underline">
            Getting started
          </Link>
        </p>
        <h1 className="text-3xl font-semibold">PermDock devtools</h1>
        <p className="text-muted-foreground">
          A canned member and admin policy. Switch the role and permission to
          see decide and describe. This is not an export of permdock/react. Apps
          build overlays from useSubject and the decision event.
        </p>
      </div>
      <DevtoolsPanel />
    </main>
  );
}
