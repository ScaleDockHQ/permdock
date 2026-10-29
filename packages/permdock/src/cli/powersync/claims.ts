import type { PowerSyncStream, StreamDialect } from "./streams.ts";

/** The `/docs` section that explains why a claim stream needs a reconnect. */
export const RECONNECT_DOCS =
  "/docs/adapters/react-native#role-and-tenant-changes";

/** A dialect that records every claim name a query reads. */
export function claimRecorder(dialect: StreamDialect): {
  readonly dialect: StreamDialect;
  readonly names: ReadonlySet<string>;
} {
  const names = new Set<string>();
  return {
    names,
    dialect: {
      ...dialect,
      claim: (name) => {
        names.add(name);
        return dialect.claim(name);
      },
      claims: (name) => {
        names.add(name);
        return dialect.claims(name);
      },
    },
  };
}

/** The recorded claims the kept queries still read, sorted. */
export function claimsIn(
  queries: readonly string[],
  names: ReadonlySet<string>,
  dialect: StreamDialect,
): readonly string[] {
  return [...names]
    .filter((name) =>
      queries.some(
        (query) =>
          query.includes(dialect.claim(name)) ||
          query.includes(dialect.claims(name)),
      ),
    )
    .toSorted();
}

/**
 * One line per stream that reads a token claim: PowerSync keeps the claims a
 * connection started with, so a changed claim needs a reconnect.
 */
export function claimWarnings(
  streams: readonly PowerSyncStream[],
): readonly string[] {
  return streams
    .filter((stream) => stream.claims.length > 0)
    .map(
      (stream) =>
        `stream ${stream.name} reads token claims ${stream.claims.join(", ")}: PowerSync keeps the claims it connected with, so refresh the session and reconnect after a role or tenant change (${RECONNECT_DOCS})`,
    );
}
