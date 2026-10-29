import { createClient } from "@supabase/supabase-js";
import { describe, expectTypeOf, it } from "vitest";

import type { RefreshTrigger } from "../../src/client/refresh-on.ts";
import type { AppStateModule } from "../../src/react-native/subscriptions.ts";

import { nativeRefresh } from "../../src/react-native/native-refresh.ts";

declare const appState: AppStateModule;

declare class PowerSyncDatabase {
  public connect(
    connector: { readonly uploadData: () => Promise<void> },
    options?: { readonly params?: Record<string, unknown> },
  ): Promise<void>;
  public disconnect(): Promise<void>;
  public getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
  public watch(
    sql: string,
    parameters: unknown[] | undefined,
    handler: { readonly onResult: (results: unknown) => void },
    options?: { readonly signal?: AbortSignal },
  ): void;
}

describe(nativeRefresh, () => {
  it("takes a supabase-js client and a PowerSync database structurally", () => {
    const supabase = createClient("http://localhost:54321", "anon");
    const db = new PowerSyncDatabase();
    const connector = { uploadData: async () => undefined };
    expectTypeOf(
      nativeRefresh({ supabase, appState, powersync: { db, connector } }),
    ).toEqualTypeOf<RefreshTrigger>();
  });
});
