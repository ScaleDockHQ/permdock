import { expect, it } from "vitest";

import type {
  Principal,
  PrincipalIdentity,
  PrincipalSource,
} from "../../index.ts";

import {
  loadPrincipal,
  loadPrincipalByIdentity,
} from "../../core/principal-source.ts";

function isFrozenDeep(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  return (
    Object.isFrozen(value) &&
    Object.values(value).every((item) => isFrozenDeep(item))
  );
}

/**
 * Checks a `PrincipalSource`: `principal` answers each listed id with the
 * expected principal or `null`, never another id; `principalByIdentity`
 * resolves each listed identity to the expected principal id or `null`, and an
 * email matches trimmed and in any case.
 */
export function testPrincipalSource(
  source: PrincipalSource,
  options: {
    readonly principals: readonly {
      readonly id: string;
      readonly tenant?: string;
      /**
       * The principal `principal(id)` returns, or `null` for none; omit to
       * check only the shape.
       */
      readonly expect?: Principal | null;
    }[];
    readonly identities?: readonly {
      readonly identity: PrincipalIdentity;
      /** The id of the principal the identity resolves to, or `null` for none. */
      readonly expect: string | null;
    }[];
  },
): void {
  it("returns the principal with the asked id, or null", async () => {
    for (const entry of options.principals) {
      let found: unknown;
      try {
        found = await source.principal(
          entry.id,
          entry.tenant === undefined ? {} : { tenant: entry.tenant },
        );
      } catch {
        found = null;
      }
      expect(found === null || typeof found === "object").toBe(true);
      if (found !== null) {
        expect(await loadPrincipal(source, entry.id, entry.tenant)).toEqual(
          found,
        );
      }
      if (entry.expect !== undefined) {
        expect(found).toEqual(entry.expect);
      }
    }
  });

  it("returns principals a caller cannot change", async () => {
    for (const entry of options.principals) {
      const found = await loadPrincipal(source, entry.id, entry.tenant);
      if (found !== null) {
        expect(isFrozenDeep(found)).toBe(true);
      }
    }
  });

  it("answers an empty or unknown id with null", async () => {
    expect(await loadPrincipal(source, "")).toBeNull();
    expect(
      await loadPrincipal(source, "permdock-conformance-unknown-principal"),
    ).toBeNull();
  });

  if (options.identities !== undefined && options.identities.length > 0) {
    const identities = options.identities;
    it("resolves linked identities and nothing else", async () => {
      for (const entry of identities) {
        const found = await loadPrincipalByIdentity(source, entry.identity);
        expect(found?.id ?? null).toBe(entry.expect);
      }
    });

    it("matches an email trimmed and in any case", async () => {
      for (const entry of identities) {
        if (entry.identity.kind !== "email" || entry.expect === null) {
          continue;
        }
        const shouted = await loadPrincipalByIdentity(source, {
          kind: "email",
          value: `  ${entry.identity.value.toUpperCase()}  `,
        });
        expect(shouted?.id ?? null).toBe(entry.expect);
      }
    });
  }
}
