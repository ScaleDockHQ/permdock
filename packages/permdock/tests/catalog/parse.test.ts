import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CatalogDocument } from "../../src/catalog/index.ts";

import { parseCatalog, rowConditionKeys } from "../../src/catalog/index.ts";
import { catalogSchema } from "../../src/catalog/schema.ts";
import { catalogSchemaDocument } from "../../src/cli/catalog-doc.ts";
import { catalogPath } from "../../src/cli/index.ts";
import { PermDockValidationError } from "../../src/core/errors.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

// SAFETY: catalog-v1.json is the package's own JSON Schema, a top-level object.
const fileSchema = JSON.parse(
  readFileSync(
    new URL("../../schemas/catalog-v1.json", import.meta.url),
    "utf8",
  ),
) as object;
const ajv = new Ajv2020({ strict: false }).compile(fileSchema);

/** Every catalog committed under the example apps and the test fixtures. */
function committedCatalogs(): readonly string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.name.endsWith(".catalog.json")) {
        found.push(full);
      }
    }
  };
  for (const dir of [
    "apps/examples",
    "tests/e2e/fixtures",
    "tests/integration/fixtures",
  ]) {
    visit(path.join(root, dir));
  }
  return found.toSorted();
}

const base = {
  $schema: "https://permdock.dev/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-10-01T00:00:00.000Z",
  generator: "permdock@0.1.0",
  resources: { post: { id: "id", schema: null } },
  permissions: [
    {
      key: "post.update",
      scope: "post:update",
      resource: "post",
      action: "update",
      arity: "instance",
      meta: {},
      usages: [{ file: "src/a.ts", line: 3, call: "assert" }],
      rowConditions: true,
      approvals: ["human", { distinct: true, staleOn: "resource-change" }],
    },
    {
      key: "post.create",
      scope: "post:create",
      resource: "post",
      action: "create",
      arity: "collection",
      meta: { title: "New post" },
      usages: [],
      rowConditions: false,
    },
  ],
  scopes: [{ name: "tenant", key: "orgId" }],
  roles: [{ key: "admin", on: "tenant", min: 1 }],
  plans: [{ key: "pro" }],
};

type Mutation = (doc: Record<string, unknown>) => unknown;

function mutated(mutate: Mutation): Record<string, unknown> {
  // SAFETY: structuredClone of a plain JSON object is a plain JSON object of the same shape.
  const doc = structuredClone(base) as Record<string, unknown>;
  mutate(doc);
  return doc;
}

function permission(doc: Record<string, unknown>): Record<string, unknown> {
  const permissions = doc["permissions"];
  const first: unknown = Array.isArray(permissions)
    ? permissions[0]
    : undefined;
  if (first === null || typeof first !== "object") {
    throw new TypeError("base has a permission");
  }
  // SAFETY: first is a non-null object from base's permissions array, a JSON object.
  return first as Record<string, unknown>;
}

const invalid: readonly [string, Mutation][] = [
  ["version 2", (doc) => (doc["version"] = 2)],
  ["no $schema", (doc) => delete doc["$schema"]],
  ["no generatedAt", (doc) => delete doc["generatedAt"]],
  ["no generator", (doc) => delete doc["generator"]],
  ["permissions not an array", (doc) => (doc["permissions"] = {})],
  ["resources an array", (doc) => (doc["resources"] = [])],
  [
    "a resource without id",
    (doc) => (doc["resources"] = { post: { schema: null } }),
  ],
  [
    "a resource without schema",
    (doc) => (doc["resources"] = { post: { id: "id" } }),
  ],
  ["a permission without key", (doc) => delete permission(doc)["key"]],
  ["a permission without meta", (doc) => delete permission(doc)["meta"]],
  ["a permission without usages", (doc) => delete permission(doc)["usages"]],
  ["an unknown arity", (doc) => (permission(doc)["arity"] = "many")],
  ["meta an array", (doc) => (permission(doc)["meta"] = [])],
  [
    "a usage line that is not an integer",
    (doc) =>
      (permission(doc)["usages"] = [{ file: "a", line: 1.5, call: "can" }]),
  ],
  ["hostable false", (doc) => (permission(doc)["hostable"] = false)],
  [
    "rowConditions a string",
    (doc) => (permission(doc)["rowConditions"] = "yes"),
  ],
  ["an unknown approval", (doc) => (permission(doc)["approvals"] = ["robot"])],
  [
    "an approval staleOn other than resource-change",
    (doc) => (permission(doc)["approvals"] = [{ staleOn: "always" }]),
  ],
  [
    "breakGlass without reason",
    (doc) =>
      (permission(doc)["breakGlass"] = { overrides: [], obligations: [] }),
  ],
  ["a role without key", (doc) => (doc["roles"] = [{ on: "tenant" }])],
  [
    "a role on a non-name",
    (doc) => (doc["roles"] = [{ key: "admin", on: "Tenant" }]),
  ],
  ["a role min of 0", (doc) => (doc["roles"] = [{ key: "admin", min: 0 }])],
  [
    "an activation without justification",
    (doc) => (doc["roles"] = [{ key: "admin", activation: {} }]),
  ],
  ["a scope without key", (doc) => (doc["scopes"] = [{ name: "tenant" }])],
  ["a plan without key", (doc) => (doc["plans"] = [{}])],
];

describe("catalog-v1 schema", () => {
  it("matches schemas/catalog-v1.json and the catalog --format schema output", () => {
    expect(fileSchema).toEqual(catalogSchema);
    expect(catalogSchemaDocument()).toEqual(fileSchema);
  });
});

describe("parseCatalog", () => {
  const catalogs = committedCatalogs();

  it("finds the committed catalogs", () => {
    expect(catalogs.length).toBeGreaterThan(3);
  });

  for (const file of catalogs) {
    it(`agrees with Ajv on ${file.slice(root.length)}`, () => {
      const text = readFileSync(file, "utf8");
      const json: unknown = JSON.parse(text);
      if (file.endsWith("drifted.catalog.json")) {
        expect(ajv(json)).toBe(false);
        expect(() => parseCatalog(json)).toThrow(PermDockValidationError);
        return;
      }
      ajv(json);
      expect(ajv.errors ?? []).toEqual([]);
      const parsed = parseCatalog(json);
      expect(parsed).toEqual(json);
      expect(parseCatalog(text)).toEqual(json);
    });
  }

  it("accepts a minimal catalog and every optional field", () => {
    expect(ajv(base)).toBe(true);
    expect(parseCatalog(base)).toEqual(base);
  });

  it.each(invalid)("rejects %s, as Ajv does", (_, mutate) => {
    const doc = mutated(mutate);
    expect(ajv(doc)).toBe(false);
    let thrown: unknown;
    try {
      parseCatalog(doc);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermDockValidationError);
    if (thrown instanceof PermDockValidationError) {
      expect(thrown.code).toBe("invalid-data");
      expect(thrown.boundary).toBe("catalog");
      expect(thrown.issues.length).toBeGreaterThan(0);
    }
  });

  it("reports every issue with its path", () => {
    const doc = mutated((d) => {
      delete permission(d)["meta"];
      d["version"] = 2;
    });
    try {
      parseCatalog(doc);
      expect.unreachable();
    } catch (error) {
      if (!(error instanceof PermDockValidationError)) {
        throw error;
      }
      expect(error.issues.map((item) => item.path)).toEqual([
        ["version"],
        ["permissions", 0, "meta"],
      ]);
      expect(error.message).toBe(
        "PermDock: invalid catalog at version: Expected 1 (and 1 more)",
      );
    }
  });

  it("returns a deep-frozen copy that does not alias the input", () => {
    const doc = mutated(() => undefined);
    const parsed = parseCatalog(doc);
    expect(parsed).not.toBe(doc);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.permissions[0]?.meta)).toBe(true);
    expect(Object.isFrozen(doc)).toBe(false);
  });

  it("keeps __proto__ an own key and never pollutes Object.prototype", () => {
    const text = JSON.stringify(base).replace(
      '"meta":{}',
      '"meta":{"__proto__":{"polluted":true}}',
    );
    const parsed = parseCatalog(
      text.replace('{"$schema"', '{"__proto__":{"polluted":true},"$schema"'),
    );
    const meta = parsed.permissions[0]?.meta ?? {};
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
    expect(Object.hasOwn(meta, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });

  it("ignores inherited keys", () => {
    const doc = Object.create({ hostable: false });
    Object.assign(
      doc,
      mutated(() => undefined),
    );
    expect(() => parseCatalog(doc)).toThrow(/Expected a plain object/u);
  });

  it.each([
    ["invalid JSON text", '{"version":'],
    ["a non-object", 42],
    ["null", null],
    ["an array", []],
    ["a function value", { ...base, generator: () => "x" }],
    ["a Date", { ...base, generatedAt: new Date(0) }],
    [
      "a non-finite number",
      { ...base, roles: [{ key: "a", min: Number.NaN }] },
    ],
  ])("rejects %s", (_, input) => {
    expect(() => parseCatalog(input)).toThrow(PermDockValidationError);
  });

  it("rejects a cycle and a throwing getter", () => {
    const cyclic: Record<string, unknown> = mutated(() => undefined);
    cyclic["resources"] = { post: { id: "id", schema: cyclic } };
    expect(() => parseCatalog(cyclic)).toThrow(PermDockValidationError);
    const throwing = mutated(() => undefined);
    Object.defineProperty(throwing, "generator", {
      enumerable: true,
      get(): never {
        throw new Error("boom");
      },
    });
    expect(() => parseCatalog(throwing)).toThrow(PermDockValidationError);
    const throwingValue = mutated(() => undefined);
    Object.defineProperty(throwingValue, "generator", {
      enumerable: true,
      get(): never {
        // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- a getter may throw a non-Error value
        throw "boom";
      },
    });
    expect(() => parseCatalog(throwingValue)).toThrow(
      "Could not read the input: boom",
    );
  });
});

describe("rowConditionKeys", () => {
  it("lists the permissions marked rowConditions: true", () => {
    const catalog: CatalogDocument = parseCatalog(base);
    expect([...rowConditionKeys(catalog)]).toEqual(["post.update"]);
  });
});

describe("catalogPath", () => {
  const cwd = "/repo/app";

  it("prefers collect.out, then catalog.out, then permissions.catalog.json", () => {
    expect(
      catalogPath(
        { collect: { out: "a.json" }, catalog: { out: "b.json" } },
        cwd,
      ),
    ).toBe("/repo/app/a.json");
    expect(catalogPath({ catalog: { out: "b.json" } }, cwd)).toBe(
      "/repo/app/b.json",
    );
    expect(catalogPath({}, cwd)).toBe("/repo/app/permissions.catalog.json");
  });

  it("lets an explicit out override the config", () => {
    expect(catalogPath({ collect: { out: "a.json" } }, cwd, "c.json")).toBe(
      "/repo/app/c.json",
    );
  });
});
