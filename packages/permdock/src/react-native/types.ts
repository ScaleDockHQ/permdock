import type { ReactNode } from "react";

import type {
  Snapshot,
  SnapshotSource,
  TokenVerifier,
} from "../core/interfaces.ts";

export type PermDockStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

export type NativeRevalidate = "launch" | "focus" | number;

/**
 * Calls `listener` when the app changes state; `active` is `false` when it
 * goes to the background. A listener called without an argument counts as
 * a return to the foreground.
 */
export type SubscribeForeground = (
  listener: (active?: boolean) => void,
) => () => void;

/** Calls `listener` with `false` when the device loses connectivity and `true` when it returns. */
export type SubscribeOnline = (
  listener: (online: boolean) => void,
) => () => void;

export type NativePermDockProviderProps = {
  readonly storage: PermDockStorage;
  /**
   * The signed-in principal's id, or `null` when nobody is signed in. Only a
   * persisted snapshot for this id is read or written; `null` clears storage.
   */
  readonly subjectId: string | null;
  readonly snapshot?: Snapshot | string;
  readonly snapshotUrl?: string;
  /** Hydrates from the device's own rows (`localSnapshot`); with `snapshotUrl` too, the latest answer wins. */
  readonly source?: SnapshotSource;
  readonly endpoint?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly revalidate?: NativeRevalidate;
  readonly subscribeForeground?: SubscribeForeground;
  readonly subscribeOnline?: SubscribeOnline;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly children: ReactNode;
};
