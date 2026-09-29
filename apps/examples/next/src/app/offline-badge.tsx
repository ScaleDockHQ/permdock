'use client';

import { useOffline } from 'next/offline';

/** Snapshot-backed gates keep answering offline; the badge only says so. */
export function OfflineBadge() {
  const offline = useOffline();
  if (!offline) {
    return null;
  }
  return (
    <p role="status" data-testid="offline">
      Offline: showing the permissions from your last visit.
    </p>
  );
}
