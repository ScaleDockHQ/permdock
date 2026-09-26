export type RevocationEvent = {
  readonly principal: string;
  readonly session?: string;
  readonly tenant?: string;
  /** `session-revoked` ends a connection; `changed` makes it re-resolve its subject. */
  readonly kind: 'session-revoked' | 'changed';
};

export type RevocationListener = (event: RevocationEvent) => void;

/**
 * Tells long-lived connections that a subject changed. A feed can only end or
 * revalidate a connection, never grant; a lost event falls back to expiry.
 */
export type RevocationFeed = {
  subscribe(listener: RevocationListener): () => void;
  revoke(event: RevocationEvent): void | Promise<void>;
};

function isRevocationEvent(value: unknown): value is RevocationEvent {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.principal === 'string' &&
    event.principal.length > 0 &&
    (event.kind === 'session-revoked' || event.kind === 'changed') &&
    (event.session === undefined || typeof event.session === 'string') &&
    (event.tenant === undefined || typeof event.tenant === 'string')
  );
}

/** In-process feed; a multi-replica app bridges `revoke` to its own pub/sub. */
export function memoryRevocationFeed(): RevocationFeed {
  const listeners = new Set<RevocationListener>();
  return Object.freeze({
    subscribe(listener: RevocationListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revoke(event: RevocationEvent): void {
      if (!isRevocationEvent(event)) {
        throw new TypeError('PermDock: invalid revocation event.');
      }
      const frozen = Object.freeze({ ...event });
      for (const listener of listeners) {
        try {
          listener(frozen);
        } catch {
          // one listener must not stop the others
        }
      }
    },
  });
}
