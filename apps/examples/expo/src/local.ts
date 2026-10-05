import {
  localSnapshot,
  type LocalSnapshotManifest,
} from "permdock/react-native";
import { AppState } from "react-native";

import manifest from "./permdock-manifest.json";

/** Stands in for the rows a sync engine (PowerSync, Electric, SQLite) keeps on the device. */
type UserRow = { readonly id: string; roles: readonly string[] };

const user: UserRow = { id: "u1", roles: ["member"] };
const listeners = new Set<() => void>();

export function setRoles(roles: readonly string[]): void {
  user.roles = roles;
  for (const listener of listeners) {
    listener();
  }
}

export const source = localSnapshot({
  // SAFETY: scripts/manifest.ts writes this file from localSnapshotManifest(policy); JSON imports widen `v: 1` to number.
  manifest: manifest as LocalSnapshotManifest,
  // oxlint-disable-next-line eslint/require-await, typescript/require-await -- a device database query is asynchronous
  read: async () => ({ principal: { id: user.id, roles: user.roles } }),
  subscribe: (listener) => {
    listeners.add(listener);
    // Rows another device changed arrive while the app is in the background.
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        listener();
      }
    });
    return () => {
      listeners.delete(listener);
      foreground.remove();
    };
  },
});
