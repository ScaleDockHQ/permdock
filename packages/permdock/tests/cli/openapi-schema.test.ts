import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseSchema,
  patchOas33,
  validateOpenapi,
  validateOverlay,
} from "../../src/cli/openapi-schema.ts";
import { run } from "../../src/cli/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");
const URLS = [
  "--authorization-url",
  "https://auth.example.com/authorize",
  "--token-url",
  "https://auth.example.com/token",
];

const temps: string[] = [];

function appCopy(openapi = "3.2.0"): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "schema-"));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  // SAFETY: the mini-app fixture's openapi.json is an OpenAPI document with an openapi field.
  const doc = JSON.parse(readFileSync(join(dir, "openapi.json"), "utf8")) as {
    openapi: string;
  };
  doc.openapi = openapi;
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(doc));
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

describe("OpenAPI and Overlay output conformance", () => {
  it.each([
    ["3.2", "3.2.0", []],
    [
      "3.2",
      "3.2.0",
      [
        "--device-flow",
        "--device-authorization-url",
        "https://auth.example.com/device",
      ],
    ],
    [
      "3.2",
      "3.2.0",
      [
        "--profile",
        "fapi2",
        "--metadata-url",
        "https://auth.example.com/.well-known/oauth-authorization-server",
      ],
    ],
    ["3.1", "3.1.1", []],
    [
      "3.1",
      "3.1.1",
      [
        "--device-flow",
        "--device-authorization-url",
        "https://auth.example.com/device",
      ],
    ],
  ] as const)(
    "emits a valid OpenAPI %s document (%s, %j)",
    async (target, version, extra) => {
      const cwd = appCopy(version);
      const result = await run(
        [
          "openapi",
          "emit",
          "--doc",
          "openapi.json",
          "--out",
          "out.json",
          "--target",
          target,
          ...URLS,
          ...extra,
        ],
        { cwd },
      );
      expect(result.stdout).toContain("wrote");
      expect(validateOpenapi(readJson(cwd, "out.json"))).toEqual({
        ok: true,
        version: target,
      });
    },
  );

  it("adds x-permdock-arity only behind --arity, and stays valid", async () => {
    const cwd = appCopy();
    // SAFETY: the mini-app fixture's openapi.json has a paths object.
    const doc = readJson(cwd, "openapi.json") as {
      paths: Record<string, unknown>;
    };
    doc.paths["/posts"] = {
      get: {
        operationId: "listPosts",
        "x-permdock-permissions": ["post.list"],
      },
    };
    writeFileSync(join(cwd, "openapi.json"), JSON.stringify(doc));
    const emit = (out: string, extra: readonly string[]) =>
      run(
        [
          "openapi",
          "emit",
          "--doc",
          "openapi.json",
          "--out",
          out,
          ...URLS,
          ...extra,
        ],
        { cwd },
      );

    await emit("plain.json", []);
    expect(JSON.stringify(readJson(cwd, "plain.json"))).not.toContain(
      "x-permdock-arity",
    );

    await emit("arity.json", ["--arity"]);
    // SAFETY: arity.json is the OpenAPI document written by `openapi emit` above.
    const out = readJson(cwd, "arity.json") as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(out.paths["/posts/{id}"]?.["delete"]?.["x-permdock-arity"]).toEqual({
      kind: "instance",
      parameter: "id",
    });
    expect(out.paths["/posts"]?.["get"]?.["x-permdock-arity"]).toEqual({
      kind: "collection",
    });
    expect(validateOpenapi(out).ok).toBe(true);
  });

  it("emits a valid Overlay 1.1 document", async () => {
    const cwd = appCopy();
    const result = await run(
      [
        "openapi",
        "emit",
        "--doc",
        "openapi.json",
        "--format",
        "overlay",
        "--out",
        "permdock.overlay.json",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(validateOverlay(readJson(cwd, "permdock.overlay.json"))).toEqual({
      ok: true,
    });
  });

  it("refuses to turn a valid document into an invalid one", async () => {
    const cwd = appCopy();
    const result = await run(
      ["openapi", "emit", "--doc", "openapi.json", "--out", "out.json"],
      { cwd },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "must have required property 'authorizationUrl'",
    );
    expect(result.stdout).toContain("--authorization-url");
  });

  it("keeps the flow URLs a document already declares", async () => {
    const cwd = appCopy();
    // SAFETY: the mini-app fixture's openapi.json is a JSON object.
    const doc = readJson(cwd, "openapi.json") as Record<string, unknown>;
    doc["components"] = {
      securitySchemes: {
        permdockOAuth: {
          type: "oauth2",
          description: "Ours",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://id.example.com/authorize",
              tokenUrl: "https://id.example.com/token",
              scopes: {},
            },
          },
        },
      },
    };
    writeFileSync(join(cwd, "openapi.json"), JSON.stringify(doc));
    const result = await run(
      ["openapi", "emit", "--doc", "openapi.json", "--out", "out.json"],
      { cwd },
    );
    expect(result.code).toBe(0);
    // SAFETY: out.json is emitted from the doc above, whose permdockOAuth scheme has this shape.
    const out = readJson(cwd, "out.json") as {
      components: {
        securitySchemes: {
          permdockOAuth: {
            description: string;
            flows: { authorizationCode: Record<string, unknown> };
          };
        };
      };
    };
    const scheme = out.components.securitySchemes.permdockOAuth;
    expect(scheme.description).toBe("Ours");
    expect(scheme.flows.authorizationCode).toMatchObject({
      authorizationUrl: "https://id.example.com/authorize",
      tokenUrl: "https://id.example.com/token",
    });
    // SAFETY: an emitted oauth2 flow always carries a scopes object.
    expect(
      Object.keys(scheme.flows.authorizationCode["scopes"] as object),
    ).not.toEqual([]);
  });

  it("reports why a document is not valid", () => {
    expect(validateOpenapi({ openapi: "3.0.3" })).toEqual({
      ok: false,
      error: "expected an OpenAPI 3.1, 3.2 or 3.3 document",
    });
    const missing = validateOpenapi({ openapi: "3.2.0", paths: {} });
    expect(missing.ok ? "" : missing.error).toContain(
      "required property 'info'",
    );
    const overlay = validateOverlay({ overlay: "1.1.0", actions: [] });
    expect(overlay.ok).toBe(false);
  });

  it.each([null, "openapi: 3.2.0", [], { openapi: 3.2 }, { openapi: "3.4.0" }])(
    "rejects %j as not an OpenAPI 3.1, 3.2 or 3.3 document",
    (document) => {
      expect(validateOpenapi(document)).toEqual({
        ok: false,
        error: "expected an OpenAPI 3.1, 3.2 or 3.3 document",
      });
    },
  );
});

describe("the pinned OpenAPI 3.3 schema", () => {
  const PROFILE_DOC = {
    openapi: "3.3.0",
    info: { title: "mini", version: "1" },
    components: {
      securitySchemes: {
        fapi: {
          type: "profile",
          profileMetadata: {
            name: "fapi-20-security-profile",
            servers: [{ url: "https://auth.example.com" }],
          },
        },
      },
      securityProfileRequirements: {
        read: {
          securityScheme: { $ref: "#/components/securitySchemes/fapi" },
          scopes: ["post:read"],
        },
      },
    },
    paths: {},
  };

  it("accepts a profile scheme and securityProfileRequirements", () => {
    expect(validateOpenapi(PROFILE_DOC)).toEqual({ ok: true, version: "3.3" });
  });

  it("requires profileMetadata on a profile scheme and scopes on a requirement", () => {
    const noMetadata = validateOpenapi({
      ...PROFILE_DOC,
      components: {
        securitySchemes: { fapi: { type: "profile" } },
      },
    });
    expect(noMetadata.ok ? "" : noMetadata.error).toContain(
      "document is not valid OpenAPI 3.3",
    );
    const noScopes = validateOpenapi({
      ...PROFILE_DOC,
      components: {
        ...PROFILE_DOC.components,
        securityProfileRequirements: {
          read: { securityScheme: { $ref: "#/x" } },
        },
      },
    });
    expect(noScopes.ok ? "" : noScopes.error).toContain(
      "required property 'scopes'",
    );
  });

  it("keeps the profile scheme type out of OpenAPI 3.2", () => {
    const result = validateOpenapi({
      ...PROFILE_DOC,
      components: { securitySchemes: PROFILE_DOC.components.securitySchemes },
      openapi: "3.2.0",
    });
    expect(result.ok ? "" : result.error).toContain(
      "document is not valid OpenAPI 3.2",
    );
  });

  it("patches a schema without a type enum or allOf", () => {
    const schema = patchOas33({
      properties: { openapi: {} },
      $defs: {
        "security-scheme": { properties: { type: {} } },
        components: { properties: {} },
      },
    });
    expect(schema).toMatchObject({
      $id: expect.stringMatching(
        /^https:\/\/permdock\.dev\/schemas\/openapi\/oas-3\.3\//u,
      ),
      properties: { openapi: { pattern: String.raw`^3\.3\.\d+(-.+)?$` } },
      $defs: {
        "security-scheme": {
          properties: { type: { enum: ["profile"] } },
          allOf: [expect.objectContaining({ if: expect.anything() })],
        },
        components: {
          properties: {
            securityProfileRequirements: expect.objectContaining({
              type: "object",
            }),
          },
        },
      },
    });
  });

  it("names the missing node of a schema it cannot patch", () => {
    expect(() =>
      patchOas33({ properties: { openapi: {} }, $defs: { components: {} } }),
    ).toThrow("PermDock CLI: OpenAPI schema has no security-scheme");
    expect(() => patchOas33({})).toThrow(
      "PermDock CLI: OpenAPI schema has no properties.openapi",
    );
  });
});

describe("parseSchema", () => {
  it("rewrites the #meta dynamic reference", () => {
    expect(
      parseSchema('{ "items": { "$dynamicRef": "#meta" } }', "x.json"),
    ).toEqual({ items: { $ref: "#/$defs/schema" } });
  });

  it.each(["[]", '"text"', "null"])("rejects %s", (text) => {
    expect(() => parseSchema(text, "x.json")).toThrow(
      "PermDock CLI: x.json is not a JSON Schema",
    );
  });
});
