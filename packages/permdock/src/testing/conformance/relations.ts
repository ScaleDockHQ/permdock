import { expect, it } from "vitest";

import type { RelationHolder, RelationSource } from "../../index.ts";

function holderKey(holder: RelationHolder): string {
  return "group" in holder
    ? `${holder.group.resource}:${holder.group.id}#${holder.group.relation}`
    : holder.principal.id;
}

/**
 * A `RelationSource` answers facts only: well-formed chains nearest first and
 * no longer than `depth`, holders with principal ids or group references and
 * numeric instants, a `truncated` chain only when more ancestors exist, and
 * empty answers (never a throw) for an object it does not know. `expect` pins
 * the chains, holders and links for `objects`, keyed `resource:id`,
 * `resource:id#relation` and `resource:id>link`; a group holder is written
 * `resource:id#relation`.
 */
export function testRelationSource(
  source: RelationSource,
  options: {
    readonly objects: readonly {
      readonly resource: string;
      readonly id: string;
      readonly relation?: string;
    }[];
    readonly expect?: {
      readonly ancestors?: Readonly<Record<string, readonly string[]>>;
      readonly holders?: Readonly<Record<string, readonly string[]>>;
      /** Keyed `resource:id>link`, the id the link leads to. */
      readonly links?: Readonly<Record<string, string>>;
    };
  },
): void {
  it("returns chains nearest first, within depth, and truncated only when more exist", async () => {
    for (const object of options.objects) {
      const full = await source.ancestors({
        resource: object.resource,
        id: object.id,
        through: "parent",
        depth: 32,
      });
      expect(Array.isArray(full.ancestors)).toBe(true);
      for (const ancestor of full.ancestors) {
        expect(ancestor.id).toBeTypeOf("string");
        expect(ancestor.id).not.toBe("");
      }
      expect(full.ancestors.length).toBeLessThanOrEqual(32);
      const expected =
        options.expect?.ancestors?.[`${object.resource}:${object.id}`];
      if (expected !== undefined) {
        expect(full.ancestors.map((ancestor) => ancestor.id)).toStrictEqual(
          expected,
        );
      }
      if (full.ancestors.length > 1) {
        const short = await source.ancestors({
          resource: object.resource,
          id: object.id,
          through: "parent",
          depth: 1,
        });
        expect(short.ancestors.map((ancestor) => ancestor.id)).toStrictEqual([
          full.ancestors[0]?.id,
        ]);
        expect(short.truncated).toBe(true);
      }
      const none = await source.ancestors({
        resource: object.resource,
        id: object.id,
        through: "parent",
        depth: 0,
      });
      expect(none.ancestors).toStrictEqual([]);
    }
  });

  it("returns well-formed holders", async () => {
    for (const object of options.objects) {
      if (object.relation === undefined) {
        continue;
      }
      const holders = await source.related({
        resource: object.resource,
        id: object.id,
        relation: object.relation,
      });
      expect(Array.isArray(holders)).toBe(true);
      for (const holder of holders) {
        if ("group" in holder) {
          for (const part of [
            holder.group.resource,
            holder.group.id,
            holder.group.relation,
          ]) {
            expect(part).toBeTypeOf("string");
            expect(part).not.toBe("");
          }
        } else {
          expect(holder.principal.id).toBeTypeOf("string");
        }
        for (const instant of [holder.startsAt, holder.expiresAt]) {
          expect(
            instant === undefined ||
              (typeof instant === "number" && Number.isFinite(instant)),
          ).toBe(true);
        }
      }
      const expected =
        options.expect?.holders?.[
          `${object.resource}:${object.id}#${object.relation}`
        ];
      if (expected !== undefined) {
        expect(holders.map(holderKey).toSorted()).toStrictEqual(
          [...expected].toSorted(),
        );
      }
    }
  });

  it("follows each link to exactly one instance", async () => {
    for (const [key, id] of Object.entries(options.expect?.links ?? {})) {
      const [object, through] = key.split(">");
      const [resource, objectId] = (object ?? "").split(":");
      if (
        resource === undefined ||
        objectId === undefined ||
        through === undefined
      ) {
        throw new Error(`expect.links key "${key}" is not resource:id>link.`);
      }
      const linked = await source.ancestors({
        resource,
        id: objectId,
        through,
        depth: 1,
      });
      expect(linked.ancestors.map((ancestor) => ancestor.id)).toStrictEqual([
        id,
      ]);
    }
  });

  it("reads each object's row as an object, or null when there is none", async () => {
    if (source.row === undefined) {
      return;
    }
    const read = (query: { readonly resource: string; readonly id: string }) =>
      source.row?.(query);
    for (const object of options.objects) {
      const row = await read({ resource: object.resource, id: object.id });
      expect(
        row === null ||
          row === undefined ||
          (typeof row === "object" && !Array.isArray(row)),
      ).toBe(true);
    }
    const missing = await read({
      resource: options.objects[0]?.resource ?? "",
      id: "permdock-missing-object",
    });
    expect(missing ?? null).toBeNull();
  });

  it("answers an unknown object with nothing instead of throwing", async () => {
    const first = options.objects[0];
    if (first === undefined) {
      return;
    }
    const missing = { resource: first.resource, id: "permdock-missing-object" };
    expect(
      (await source.ancestors({ ...missing, through: "parent", depth: 16 }))
        .ancestors,
    ).toStrictEqual([]);
    if (first.relation !== undefined) {
      expect(
        await source.related({ ...missing, relation: first.relation }),
      ).toStrictEqual([]);
    }
  });
}
