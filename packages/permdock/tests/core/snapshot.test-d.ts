import { describe, expectTypeOf, it } from "vitest";

import type { Snapshot, TokenSigner } from "../../src/core/interfaces.ts";
import type { PermDock, SnapshotOptions } from "../../src/index.ts";

import { snapshotFor } from "../../src/index.ts";
import { alice, policy } from "../fixtures/saas.ts";

type NotSerializable =
  | ((...args: never[]) => unknown)
  | Map<unknown, unknown>
  | Set<unknown>
  | Date
  | symbol
  | bigint;

/** `true` when no property, at any depth, is a function, Map, Set, Date, symbol or bigint. */
type Serializable<T, Depth extends unknown[] = []> = Depth["length"] extends 12
  ? true
  : [T] extends [NotSerializable]
    ? false
    : T extends readonly (infer Item)[]
      ? Serializable<Item, [...Depth, unknown]>
      : T extends object
        ? false extends {
            [K in keyof T]-?: Serializable<T[K], [...Depth, unknown]>;
          }[keyof T]
          ? false
          : true
        : true;

describe("Snapshot", () => {
  it("holds only plain, serializable data", () => {
    expectTypeOf<Serializable<Snapshot>>().toEqualTypeOf<true>();
    expectTypeOf<
      Serializable<{ readonly f: () => void }>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Serializable<{ readonly m: Map<string, string> }>
    >().toEqualTypeOf<false>();
  });

  it("is what snapshotFor returns, synchronously", () => {
    expectTypeOf(snapshotFor(policy, alice)).toEqualTypeOf<Snapshot>();
  });
});

declare const permdock: PermDock;
declare const signer: TokenSigner;
declare const options: SnapshotOptions;

describe("permdock.snapshot", () => {
  it("returns a Snapshot without a signer and a token promise with one", () => {
    expectTypeOf(permdock.snapshot()).toEqualTypeOf<Snapshot>();
    expectTypeOf(
      permdock.snapshot({ tenants: "all" }),
    ).toEqualTypeOf<Snapshot>();
    expectTypeOf(permdock.snapshot({ signer })).toEqualTypeOf<
      Promise<string>
    >();
    expectTypeOf(permdock.snapshot(options)).toEqualTypeOf<
      Snapshot | Promise<string>
    >();
  });
});
