import {
  localSnapshot,
  parseLocalSnapshotManifest,
} from "permdock/react-native";

import manifest from "./permdock-manifest.json";

if (!parseLocalSnapshotManifest(manifest)) {
  throw new Error("src/permdock-manifest.json is invalid: run pnpm gen");
}

/** Stands in for the rows a sync engine (PowerSync, Electric, SQLite) keeps on the device. */
type UserRow = { readonly id: string; roles: readonly string[] };

export const user: UserRow = { id: "u1", roles: ["member"] };
const listeners = new Set<() => void>();

export function setRoles(roles: readonly string[]): void {
  user.roles = roles;
  for (const listener of listeners) {
    listener();
  }
}

export const source = localSnapshot({
  manifest,
  // oxlint-disable-next-line eslint/require-await, typescript/require-await -- a device database query is asynchronous
  read: async () => ({ principal: { id: user.id, roles: user.roles } }),
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
});
