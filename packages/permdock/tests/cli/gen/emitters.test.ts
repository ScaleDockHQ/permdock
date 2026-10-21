import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GenModel, GenResource } from "../../../src/cli/gen/model.ts";
import type { JsonSchema } from "../../../src/cli/generate.ts";

import { constantsModule } from "../../../src/cli/gen/constants.ts";
import { factoriesModule } from "../../../src/cli/gen/factories.ts";
import { camelCase, genModel } from "../../../src/cli/gen/model.ts";
import {
  jsonSchemaDocument,
  standardSchemaModule,
  typeOf,
  validatorModule,
} from "../../../src/cli/gen/schemas.ts";
import { schemaExpression } from "../../../src/cli/generate.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../../src/index.ts";

const NAMES = {
  schema: "app",
  claims: { tenant: "tenant_id", role: "user_role" },
  scopes: {},
  resources: {},
};

function model(
  resources: readonly GenResource[],
  extra: Partial<GenModel> = {},
): GenModel {
  // SAFETY: the emitters read only these ResolvedNames fields.
  const names = NAMES as unknown as GenModel["names"];
  return {
    resources,
    operations: [],
    scopes: [],
    roles: [],
    names,
    topics: [],
    labels: { permissions: [], roles: [] },
    buckets: [],
    ...extra,
  };
}

const EDGES: JsonSchema = {
  type: "object",
  properties: {
    count: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 10 },
    ratio: { type: "number", minimum: 0.5 },
    below: { type: "number", maximum: -3 },
    capped: { type: "number", maximum: 5 },
    rank: { type: "integer" },
    site: { type: "string", format: "uri", title: "Website" },
    between: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    positive: { type: "number", exclusiveMinimum: 0 },
    shape: { enum: [{ a: 1 }] },
    stamp: { type: "date" },
    mail: { type: "string", format: "email" },
    day: { type: "string", format: "date" },
    code: { type: "string", maxLength: 3 },
    long: { type: "string", minLength: 2 },
    list: { type: "array", items: { type: "string" }, minItems: 1 },
    loose: { type: "array" },
    nested: { type: "object", properties: { deep: { type: "boolean" } } },
    bare: { properties: { inner: { type: "string" } }, required: ["inner"] },
    empty: { type: "object" },
    either: { type: ["string", "number"] },
    maybe: { type: ["string", "null"] },
    maybeObject: {
      type: ["object", "null"],
      properties: { a: { type: "string" } },
    },
    maybeList: { type: ["array", "null"], items: { type: "string" } },
    level: { enum: [1, 2] },
    choice: { enum: ["a", null], type: ["string", "null"] },
    "odd-key": { type: "string" },
    anything: {},
  },
  required: [
    "count",
    "ratio",
    "below",
    "capped",
    "rank",
    "site",
    "mail",
    "day",
    "code",
    "long",
    "list",
    "loose",
    "nested",
    "bare",
    "empty",
    "either",
    "maybe",
    "maybeObject",
    "level",
    "odd-key",
    "anything",
  ],
};

const EDGE_RESOURCE: GenResource = {
  name: "edge",
  ident: "edge",
  schema: EDGES,
};

describe("gen emitters", () => {
  it("translates every JSON Schema edge for each validator kind", () => {
    for (const kind of ["zod", "valibot", "arktype"] as const) {
      const code = validatorModule(kind, model([EDGE_RESOURCE]), {
        fieldMeta: true,
      });
      expect(code).toMatchSnapshot(kind);
    }
  });

  it("writes TypeScript types, json-schema and standard-schema for the edges", () => {
    expect(typeOf(EDGES)).toMatchSnapshot();
    const operations = [
      { name: "listEdges", ident: "listEdges", results: "edge" },
    ];
    expect(
      standardSchemaModule(model([EDGE_RESOURCE], { operations }), {
        fieldMeta: false,
      }),
    ).toContain("export const listEdgesResult = resourceSchemaFromJson(");
    expect(
      JSON.parse(
        jsonSchemaDocument(
          model([{ ...EDGE_RESOURCE, name: "a/b~c" }], {
            operations: [{ name: "x", ident: "x", results: "a/b~c" }],
          }),
        ),
      ),
    ).toMatchObject({
      operations: {
        x: { results: { items: { $ref: "#/resources/a~1b~0c" } } },
      },
    });
  });

  it("stops at the nesting limit", () => {
    let schema: JsonSchema = { type: "string" };
    for (let depth = 0; depth < 9; depth += 1) {
      schema = { type: "object", properties: { n: schema }, required: ["n"] };
    }
    expect(typeOf(schema)).toContain("unknown");
    expect(
      factoriesModule(model([{ name: "deep", ident: "deep", schema }])),
    ).toContain("n: { n: { n: { n: { n: {} } } } }");
    expect(
      schemaExpression("zod", schema, undefined, { constraints: true }),
    ).toContain("z.unknown()");
  });

  it("fills required fields with valid values in factories", () => {
    const code = factoriesModule(
      model(
        [
          EDGE_RESOURCE,
          { name: "plain", ident: "plain", schema: { type: "object" } },
          { name: "none", ident: "none", schema: undefined },
        ],
        {
          scopes: [
            { name: "tenant", key: "tenantId" },
            { name: "odd-scope", key: "x" },
            { name: "global" },
          ],
        },
      ),
    );
    expect(code).toMatchSnapshot();
    expect(code).toContain(
      'readonly scope: "tenant" | "odd-scope" | "global";',
    );
    expect(factoriesModule(model([]))).toContain("readonly scope: string;");
  });

  it("rejects two topics or buckets that build the same name", () => {
    expect(() =>
      constantsModule(
        model([], { topics: ["org:{id}:chat", "org-{id}-chat"] }),
      ),
    ).toThrow(
      /topic 'org:\{id\}:chat' and 'org-\{id\}-chat' both generate the builder 'orgChat'/u,
    );
    expect(
      constantsModule(
        model([], {
          topics: ["{odd-id}"],
          buckets: [
            ["files", { scope: "tenant" }],
            ["avatars", { scope: "tenant", folder: 1 }],
          ],
        }),
      ),
    ).toMatchSnapshot();
  });

  it("names identifiers in camel case", () => {
    expect(camelCase("Org.post")).toBe("orgPost");
    expect(camelCase("2fa-codes")).toBe("_2faCodes");
  });
});

describe("the gen model", () => {
  const id = z.string();
  const permissions = definePermissions({
    "task-item": resource(z.object({ id }), { actions: ["read"] }),
    task_item: resource(z.object({ id }), { actions: ["read"] }),
    note: resource({ actions: ["read"] }),
  });
  const roles = defineRoles({ viewer: {} });
  const policy = definePolicy(
    { permissions, roles },
    {
      roles: [role(roles.viewer, [allow(permissions.note.read)])],
      subject: () => null,
    },
  );

  it("throws for two resources with one identifier", () => {
    expect(() => genModel({ policy, config: {} })).toThrow(
      /resource '(?:task-item|task_item)' and '(?:task-item|task_item)' both generate the name 'taskItem'/u,
    );
  });

  it("throws for a resource name without letters", () => {
    const only = definePolicy(
      {
        permissions: definePermissions({
          row: resource(
            z.object({
              id,
              tag: z.enum(["a", "b"]).nullable(),
              when: z.string().nullable(),
              items: z.array(z.number().nullable()),
              union: z.union([z.string(), z.number()]),
            }),
            { actions: ["read"] },
          ),
          "--": resource({ actions: ["read"] }),
        }),
      },
      { subject: () => null },
    );
    expect(() => genModel({ policy: only, config: {} })).toThrow(
      /resource '--' has no letters or digits/u,
    );
  });

  it("reads operations, roles and the config", () => {
    const only = definePolicy(
      {
        permissions: definePermissions({
          row: resource(
            z.object({
              id,
              tag: z.enum(["a"]).nullable(),
              list: z.array(z.string().nullable()),
            }),
            { actions: ["read"] },
          ),
        }),
      },
      { subject: () => null },
    );
    const built = genModel({
      policy: only,
      config: {
        rls: {
          storage: { buckets: { b: { scope: "row" }, a: { scope: "row" } } },
        },
      },
      operations: [
        {
          name: "readRow",
          permission: "row.read",
          results: "row.read",
          meta: {},
        },
        {
          name: "other",
          permission: "row.read",
          results: "nope.read",
          meta: {},
        },
        { name: "plain", permission: "row.read", meta: {} },
      ],
    });
    expect(built.operations).toStrictEqual([
      { name: "other", ident: "other" },
      { name: "plain", ident: "plain" },
      { name: "readRow", ident: "readRow", results: "row" },
    ]);
    expect(built.topics).toStrictEqual([]);
    expect(built.buckets.map(([name]) => name)).toStrictEqual(["a", "b"]);
    expect(built.resources[0]?.schema).toMatchObject({
      properties: {
        tag: { type: ["string", "null"], enum: ["a", null] },
        list: { items: { type: ["string", "null"] } },
      },
    });
    expect(validatorModule("zod", built, { fieldMeta: true })).toContain(
      'tag: z.enum(["a"]).nullable()',
    );
  });
});
