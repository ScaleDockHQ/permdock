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

export type NativePermDockProviderProps = {
  readonly storage: PermDockStorage;
  readonly snapshot?: Snapshot | string;
  readonly snapshotUrl?: string;
  /** Hydrates from the device's own rows (`localSnapshot`); with `snapshotUrl` too, the latest answer wins. */
  readonly source?: SnapshotSource;
  readonly endpoint?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly subjectId?: string;
  readonly revalidate?: NativeRevalidate;
  readonly subscribeForeground?: (listener: () => void) => () => void;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly children: ReactNode;
};
