"use client";

import { WifiOff } from "lucide-react";
import { useOffline } from "next/offline";

/** Snapshot-backed gates keep answering offline; the badge only says so. */
export function OfflineBadge() {
  const offline = useOffline();
  if (!offline) {
    return null;
  }
  return (
    <output
      data-testid="offline"
      className="bg-popover text-popover-foreground fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg"
    >
      <WifiOff className="text-muted-foreground size-4 shrink-0" />
      Offline: showing the permissions from your last visit.
    </output>
  );
}
