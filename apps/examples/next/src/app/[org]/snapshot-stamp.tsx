"use client";

import { usePermDock } from "permdock/react";

import { Skeleton } from "@/components/ui/skeleton.tsx";

const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

/** When the server issued the access snapshot; a private-cache hit repeats the first visit's time. */
export function SnapshotStamp() {
  const permdock = usePermDock();
  const { issuedAt } = permdock.snapshot();
  if (permdock.status() === "pending" || issuedAt === 0) {
    return <Skeleton className="hidden h-4 w-32 md:block" />;
  }
  return (
    <span
      data-testid="snapshot-issued"
      data-issued-at={issuedAt}
      className="text-muted-foreground hidden text-xs tabular-nums md:inline"
    >
      Access issued {clock.format(issuedAt * 1000)} UTC
    </span>
  );
}
