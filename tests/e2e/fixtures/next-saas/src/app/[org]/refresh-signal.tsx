"use client";

import { useParams, useRouter } from "next/navigation";
import { usePermDock } from "permdock/react";
import { useEffect } from "react";

declare global {
  interface Window {
    saasPausePoll?: boolean;
  }
}

function issuedAtOf(snapshot: unknown): number {
  return typeof snapshot === "object" &&
    snapshot !== null &&
    "issuedAt" in snapshot
    ? Number(snapshot.issuedAt)
    : 0;
}

/**
 * `updateTag` and `revalidateTag` only reach the browser that acted. Other
 * members poll (a realtime channel in production) for the last change to
 * their roles or the org's plan, and refresh when it is newer than the
 * snapshot they hold. Comparing against `issuedAt` instead of a previous
 * poll cannot miss a change that lands before the first poll.
 */
export function RefreshSignal() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const issuedAt = issuedAtOf(usePermDock().snapshot());
  useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (window.saasPausePoll === true) {
        return;
      }
      const response = await fetch(
        `/api/version?org=${encodeURIComponent(org)}`,
        {
          cache: "no-store",
        },
      );
      // SAFETY: the fixture's /api/version route answers { changedAt: number }
      const body = (await response.json()) as { readonly changedAt: number };
      if (!stopped && issuedAt > 0 && body.changedAt >= issuedAt) {
        router.refresh();
      }
    };
    const id = setInterval(() => {
      tick().catch(() => null);
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [org, router, issuedAt]);
  return null;
}
