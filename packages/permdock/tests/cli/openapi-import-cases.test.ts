import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { CliIo } from "../../src/cli/types.ts";

import { runOpenapiImport } from "../../src/cli/openapi-import.ts";
import { listPermissions } from "../../src/index.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function workdir(files: Readonly<Record<string, string>> = {}): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, "openapi-import-cases-"));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const IO: CliIo = { stdout: () => undefined, stderr: () => undefined };

type Input = Parameters<typeof runOpenapiImport>[0];

function importDoc(cwd: string, overrides: Partial<Input> = {}) {
  return runOpenapiImport({
    cwd,
    doc: "openapi.json",
    out: "gen.ts",
    schema: undefined,
    map: undefined,
    annotate: false,
    io: IO,
    ...overrides,
  });
}

function doc(
  paths: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    openapi: "3.2.0",
    info: { title: "t", version: "1" },
    paths,
    ...extra,
  });
}

let generation = 0;

async function leaves(dir: string, file = "gen.ts") {
  generation += 1;
  // SAFETY: the module is the permissions file `openapi import` just generated, which exports this.
  const module = (await import(
    `${pathToFileURL(path.join(dir, file)).href}?case=${String(generation)}`
  )) as { readonly permissions: Parameters<typeof listPermissions>[0] };
  return listPermissions(module.permissions)
    .map((leaf) => [leaf.key, leaf.kind])
    .toSorted(([a], [b]) => String(a).localeCompare(String(b)));
}

const OK = { "200": { description: "ok" } };

describe("openapi import usage errors", () => {
  it.each([
    [{ out: undefined }, {}, "openapi import needs --out <file>"],
    [{ map: "nope.json" }, {}, "PermDock CLI: --map file not found: nope.json"],
    [
      { map: "map.json" },
      { "map.json": "{ broken" },
      "PermDock CLI: --map must be a JSON object",
    ],
    [
      { map: "map.json" },
      { "map.json": '["GET /x"]' },
      "PermDock CLI: --map must be a JSON object",
    ],
    [
      { map: "map.json" },
      { "map.json": JSON.stringify({ "/posts": "post.read" }) },
      `PermDock CLI: --map entries are "METHOD /path": "resource.action" (got '/posts')`,
    ],
    [
      { map: "map.json" },
      { "map.json": JSON.stringify({ "GET /posts": 1 }) },
      `PermDock CLI: --map entries are "METHOD /path": "resource.action" (got 'GET /posts')`,
    ],
    [
      { doc: "absent.json" },
      {},
      "PermDock CLI: document not found: absent.json",
    ],
    [
      {},
      { "openapi.json": "key: [unclosed" },
      "PermDock CLI: --doc must be a JSON or YAML OpenAPI document",
    ],
    [
      {},
      { "openapi.json": "- a\n- b\n" },
      "PermDock CLI: --doc must be a JSON or YAML OpenAPI document",
    ],
    [
      {},
      { "openapi.json": "[1]" },
      "PermDock CLI: --doc must be a JSON or YAML OpenAPI document",
    ],
    [
      {},
      { "openapi.json": "a: 1\na: 2\n" },
      "PermDock CLI: --doc must be a JSON or YAML OpenAPI document",
    ],
  ] as const)("exits 2 for %j", async (overrides, files, output) => {
    expect(await importDoc(workdir(files), overrides)).toEqual({
      code: 2,
      output,
    });
  });
});

describe("openapi import from a URL", () => {
  const URL = "https://api.example.com/openapi.json";
  const BODY = doc({ "/posts": { get: { responses: OK } } });

  it("fetches the document through io.fetch", async () => {
    const dir = workdir();
    const requested: string[] = [];
    const io: CliIo = {
      ...IO,
      fetch: (input) => {
        requested.push(String(input));
        return Promise.resolve(new Response(BODY));
      },
    };
    expect(await importDoc(dir, { doc: URL, io })).toEqual({
      code: 0,
      output: "wrote gen.ts (1 resources, 1 permissions)",
    });
    expect(requested).toEqual([URL]);
    expect(await leaves(dir)).toEqual([["posts.list", "collection"]]);
  });

  it("falls back to the global fetch", async () => {
    const fetchStub = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(BODY)),
    );
    vi.stubGlobal("fetch", fetchStub);
    expect((await importDoc(workdir(), { doc: URL })).code).toBe(0);
    expect(fetchStub).toHaveBeenCalledWith(URL);
  });

  it("reports an HTTP error and an unreachable host", async () => {
    const failing: CliIo = {
      ...IO,
      fetch: () => Promise.resolve(new Response("gone", { status: 404 })),
    };
    expect(await importDoc(workdir(), { doc: URL, io: failing })).toEqual({
      code: 2,
      output: `PermDock CLI: could not fetch ${URL}: HTTP 404`,
    });
    const offline: CliIo = {
      ...IO,
      fetch: () => Promise.reject(new TypeError("offline")),
    };
    expect(await importDoc(workdir(), { doc: URL, io: offline })).toEqual({
      code: 2,
      output: `PermDock CLI: could not fetch ${URL}`,
    });
  });

  it("refuses --annotate on a remote document", async () => {
    const io: CliIo = {
      ...IO,
      fetch: () => Promise.resolve(new Response(BODY)),
    };
    expect(
      await importDoc(workdir(), { doc: URL, io, annotate: true }),
    ).toEqual({
      code: 2,
      output: "PermDock CLI: --annotate needs a local --doc file",
    });
  });
});

describe("openapi import naming", () => {
  it("derives actions from the method and arity", async () => {
    const dir = workdir({
      "openapi.json": doc({
        "/posts": {
          get: { responses: OK },
          post: { responses: OK },
          query: { responses: OK },
          options: { responses: OK },
        },
        "/posts/{id}": {
          get: { responses: OK },
          head: { responses: OK },
          post: { responses: OK },
          put: { responses: OK },
          patch: { responses: OK },
          delete: { responses: OK },
          trace: { responses: OK },
        },
      }),
    });
    expect(await importDoc(dir)).toEqual({
      code: 0,
      output: "wrote gen.ts (1 resources, 7 permissions)",
    });
    expect(await leaves(dir)).toEqual([
      ["posts.create", "collection"],
      ["posts.delete", "instance"],
      ["posts.list", "collection"],
      ["posts.options", "collection"],
      ["posts.read", "instance"],
      ["posts.trace", "instance"],
      ["posts.update", "instance"],
    ]);
  });

  it("names the resource after the first tag and cleans identifiers", async () => {
    const dir = workdir({
      "openapi.json": doc({
        "/v1/items": {
          get: {
            tags: ["blog-posts-", "other"],
            operationId: "2-list_all.",
            summary: "List",
            description: "All the posts",
            responses: OK,
          },
        },
      }),
    });
    expect((await importDoc(dir)).code).toBe(0);
    const text = readFileSync(path.join(dir, "gen.ts"), "utf8");
    expect(text).toContain("blogPosts: resource({");
    expect(text).toContain('"listAll": {');
    expect(text).toContain('"title": "List"');
    expect(text).toContain('"description": "All the posts"');
    expect(text).toContain('"tags": [\n');
    expect(text).toContain('"readOnly": true');
  });

  it("reads OpenID Connect scopes and the document-level security", async () => {
    const dir = workdir({
      "openapi.json": doc(
        {
          "/posts": { get: { responses: OK } },
          "/posts/{id}": {
            get: {
              security: [{ oidc: ["post:read"], apiKey: [] }],
              responses: OK,
            },
          },
        },
        {
          security: [{ oidc: ["post:list"] }],
          components: {
            securitySchemes: {
              oidc: {
                type: "openIdConnect",
                openIdConnectUrl:
                  "https://id.example.com/.well-known/openid-configuration",
              },
              apiKey: { type: "apiKey", name: "k", in: "header" },
            },
          },
        },
      ),
    });
    expect((await importDoc(dir)).code).toBe(0);
    expect(await leaves(dir)).toEqual([
      ["post.list", "collection"],
      ["post.read", "instance"],
    ]);
  });

  it("turns one action seen on a collection and an instance into an instance", async () => {
    const dir = workdir({
      "openapi.json": doc({
        "/posts": {
          get: { "x-permdock-permissions": ["post.read"], responses: OK },
        },
        "/posts/{id}": {
          get: { "x-permdock-permissions": ["post.read", 7], responses: OK },
        },
      }),
    });
    expect(await importDoc(dir)).toEqual({
      code: 0,
      output: "wrote gen.ts (1 resources, 1 permissions)",
    });
    expect(await leaves(dir)).toEqual([["post.read", "instance"]]);
    expect(readFileSync(path.join(dir, "gen.ts"), "utf8")).toContain(
      '"inferredFrom": "GET /posts, GET /posts/{id}"',
    );
  });

  it.each([
    ["/{id}", {}],
    ["/posts", { tags: ["123"] }],
    ["/posts", { tags: ["constructor"] }],
  ] as const)(
    "refuses an operation on %s %j it cannot name",
    async (route, extra) => {
      const dir = workdir({
        "openapi.json": doc({ [route]: { get: { ...extra, responses: OK } } }),
      });
      expect(await importDoc(dir)).toEqual({
        code: 1,
        output: `GET ${route}: cannot name a resource; add it to --map`,
      });
    },
  );

  it("imports a document with no paths", async () => {
    const dir = workdir({
      "openapi.json": JSON.stringify({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        components: {},
      }),
    });
    expect(await importDoc(dir)).toEqual({
      code: 0,
      output: "wrote gen.ts (0 resources, 0 permissions)",
    });
  });
});

describe("openapi import schemas", () => {
  const POST = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  };

  it("takes the schema from a 201 response or the request body", async () => {
    const dir = workdir({
      "openapi.json": doc(
        {
          "/posts": {
            post: {
              responses: {
                "201": {
                  description: "created",
                  content: {
                    "text/plain": { schema: { type: "string" } },
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Post" },
                    },
                  },
                },
              },
            },
          },
          "/comments": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Comment" },
                  },
                },
              },
              responses: OK,
            },
          },
        },
        {
          components: {
            schemas: {
              Post: POST,
              Comment: { $ref: "#/components/schemas/Post" },
            },
          },
        },
      ),
    });
    expect((await importDoc(dir, { schema: "zod" })).code).toBe(0);
    const text = readFileSync(path.join(dir, "gen.ts"), "utf8");
    expect(text).toContain(
      "comments: resource(z.object({ id: z.string() }), {",
    );
    expect(text).toContain("posts: resource(z.object({ id: z.string() }), {");
  });

  it.each([
    ["an unknown component", "#/components/schemas/Missing", { schemas: {} }],
    ["an external reference", "other.json#/Post", { schemas: { Post: POST } }],
    ["a prototype key", "#/components/schemas/__proto__", { schemas: {} }],
    ["no schemas", "#/components/schemas/Post", {}],
  ] as const)(
    "falls back to unknown for %s",
    async (_label, ref, components) => {
      const dir = workdir({
        "openapi.json": doc(
          {
            "/posts": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: { "application/json": { schema: { $ref: ref } } },
                  },
                },
              },
            },
          },
          { components },
        ),
      });
      expect((await importDoc(dir, { schema: "valibot" })).code).toBe(0);
      expect(readFileSync(path.join(dir, "gen.ts"), "utf8")).toContain(
        "posts: resource(v.unknown(), {",
      );
    },
  );

  it("falls back to unknown when there are no components", async () => {
    const dir = workdir({
      "openapi.json": doc({
        "/posts": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Post" },
                  },
                },
              },
            },
          },
        },
      }),
    });
    expect((await importDoc(dir, { schema: "zod" })).code).toBe(0);
    expect(readFileSync(path.join(dir, "gen.ts"), "utf8")).toContain(
      "posts: resource(z.unknown(), {",
    );
  });

  it("gives a resource with no JSON body an empty object schema", async () => {
    const dir = workdir({
      "openapi.json": doc({ "/posts": { get: {} } }),
    });
    expect((await importDoc(dir, { schema: "zod" })).code).toBe(0);
    expect(readFileSync(path.join(dir, "gen.ts"), "utf8")).toContain(
      "posts: resource(z.object({}), {",
    );
  });
});
