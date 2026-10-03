import type { Snapshot } from "../../src/core/interfaces.ts";

/** The plain snapshot `permdock.snapshot()` returns without a `signer`. */
export function unsigned(snapshot: Snapshot | Promise<string>): Snapshot {
  if (snapshot instanceof Promise) {
    throw new TypeError("expected an unsigned snapshot");
  }
  return snapshot;
}
