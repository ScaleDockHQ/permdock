import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  pd045,
  pd074,
  pd136,
  readSupabaseConfig,
  supabaseConfig,
} from "../../src/cli/supabase-config.ts";
import {
  resolveSchemas,
  schemasRefusal,
} from "../../src/cli/supabase-schemas.ts";
import { project, removeProjects } from "./doctor-kit.ts";

describe("supabase config", () => {
  afterAll(removeProjects);

  describe(readSupabaseConfig, () => {
    it("is undefined without supabase/config.toml", () => {
      expect(readSupabaseConfig(project({}))).toBeUndefined();
      expect(supabaseConfig(project({}))).toStrictEqual({});
    });

    it("reads jwt_expiry and schema_paths past comments, multi-line arrays and quoted keys", () => {
      const cwd = project({
        "supabase/config.toml": `# project settings
[api]
jwt_expiry = 9000

[auth]  # session settings
site_url = "http://localhost:3000"
jwt_expiry = 1800 # seconds

[db."migrations"]
schema_paths = [
  # helpers first
  "./schemas/permdock.sql",
  './schemas/**/*.sql', # then the rest, ] in a comment
]
`,
      });
      expect(readSupabaseConfig(cwd)).toStrictEqual({
        ok: true,
        file: "supabase/config.toml",
        format: "toml",
        config: {
          jwtExpiry: 1800,
          schemaPaths: ["./schemas/permdock.sql", "./schemas/**/*.sql"],
        },
      });
    });

    it("reads [experimental.pgdelta] and its declarative_schema_path", () => {
      expect(
        supabaseConfig(
          project({
            "supabase/config.toml": "[experimental.pgdelta]\nenabled = true\n",
          }),
        ),
      ).toStrictEqual({
        pgDelta: { enabled: true, schemaDir: "supabase/schemas" },
      });
      expect(
        supabaseConfig(
          project({
            "supabase/config.toml":
              '[experimental.pgdelta]\nenabled = true\ndeclarative_schema_path = "./db/declarative/"\n',
          }),
        ),
      ).toStrictEqual({
        pgDelta: { enabled: true, schemaDir: "supabase/db/declarative" },
      });
      expect(
        supabaseConfig(
          project({
            "supabase/config.toml": "[experimental.pgdelta]\nenabled = false\n",
          }),
        ),
      ).toStrictEqual({
        pgDelta: { enabled: false, schemaDir: "supabase/schemas" },
      });
      expect(
        supabaseConfig(
          project({
            "supabase/config.toml": '[experimental.pgdelta]\nenabled = "yes"\n',
          }),
        ),
      ).toStrictEqual({ pgDelta: { schemaDir: "supabase/schemas" } });
    });

    it("resolves the schema workflow: --schemas, then supabase.schemas, then enabled = false, else pg-delta", () => {
      const none = project({});
      expect(resolveSchemas(none, {})).toStrictEqual({
        mode: "pg-delta",
        schemaDir: "supabase/schemas",
      });
      const off = project({
        "supabase/config.toml":
          '[experimental.pgdelta]\nenabled = false\ndeclarative_schema_path = "./db"\n',
      });
      expect(resolveSchemas(off, {})).toStrictEqual({ mode: "migra" });
      expect(resolveSchemas(off, {}, "pg-delta")).toStrictEqual({
        mode: "pg-delta",
        schemaDir: "supabase/db",
      });
      expect(
        resolveSchemas(off, { supabase: { schemas: "migrations" } }),
      ).toStrictEqual({ mode: "migrations" });
      expect(
        resolveSchemas(none, { supabase: { schemas: "migra" } }, "migrations"),
      ).toStrictEqual({ mode: "migrations" });
      expect(schemasRefusal("rls generate", "pg-delta")).toBeUndefined();
      expect(schemasRefusal("rls generate", undefined)).toBeUndefined();
      expect(schemasRefusal("rls generate", "flyway")).toBe(
        "rls generate --schemas must be pg-delta, migra, migrations (got flyway)",
      );
    });

    it("reads config.jsonc as supabase config convert writes it, ahead of config.toml", () => {
      const cwd = project({
        "supabase/config.toml": "[auth]\njwt_expiry = 60\n",
        "supabase/config.jsonc": `{
  // converted from config.toml
  "auth": { "jwt_expiry": 1800, "site_url": "http://a//b" },
  "db": { "major_version": 17, "migrations": { "schema_paths": ["./schemas/*.sql",] } },
  /* pg-delta */
  "experimental": { "pgdelta": { "enabled": true } },
}
`,
      });
      expect(readSupabaseConfig(cwd)).toStrictEqual({
        ok: true,
        file: "supabase/config.jsonc",
        format: "jsonc",
        config: {
          jwtExpiry: 1800,
          majorVersion: 17,
          schemaPaths: ["./schemas/*.sql"],
          pgDelta: { enabled: true, schemaDir: "supabase/schemas" },
        },
      });
    });

    it("reads the example's config.toml, its supabase config convert output and the TOML converted back as one config", () => {
      const fixture = (name: string): string =>
        readFileSync(
          join(import.meta.dirname, "fixtures/supabase-config", name),
          "utf8",
        );
      const read = (file: string, name: string) => {
        const result = readSupabaseConfig(project({ [file]: fixture(name) }));
        return result?.ok === true ? result.config : result;
      };
      const toml = read("supabase/config.toml", "config.toml");
      expect(toml).toMatchObject({
        majorVersion: 17,
        pgDelta: { enabled: true },
        customAccessTokenHook: { enabled: true },
      });
      expect(read("supabase/config.jsonc", "config.jsonc")).toStrictEqual(toml);
      expect(
        read("supabase/config.toml", "config.roundtrip.toml"),
      ).toStrictEqual(toml);
    });

    it("refuses config.json beside config.jsonc, as the CLI does", () => {
      const cwd = project({
        "supabase/config.json": "{}",
        "supabase/config.jsonc": "{}",
      });
      expect(readSupabaseConfig(cwd)).toMatchObject({
        ok: false,
        file: "supabase/config.json",
      });
      expect(pd045(cwd)[0]?.message).toContain("both exist");
    });

    it("resolves env(NAME) values and reports an unset one by name", () => {
      const cwd = project({
        "supabase/config.toml":
          '[auth]\njwt_expiry = "env(JWT_EXPIRY)"\n[db]\nmajor_version = "env(PG_MAJOR)"\n',
      });
      expect(supabaseConfig(cwd)).toMatchObject({
        unresolvedEnv: [
          "auth.jwt_expiry = env(JWT_EXPIRY)",
          "db.major_version = env(PG_MAJOR)",
        ],
      });
      expect(
        readSupabaseConfig(cwd, { JWT_EXPIRY: "900", PG_MAJOR: "16" }),
      ).toMatchObject({ config: { jwtExpiry: 900, majorVersion: 16 } });
      expect(pd045(cwd, {}).map((finding) => finding.message)).toStrictEqual([
        "supabase/config.toml sets auth.jwt_expiry = env(JWT_EXPIRY), and the variable is unset, so PermDock reads the key as unset",
        "supabase/config.toml sets db.major_version = env(PG_MAJOR), and the variable is unset, so PermDock reads the key as unset",
      ]);
    });

    it("ignores values of the wrong type", () => {
      const cwd = project({
        "supabase/config.toml":
          '[auth]\njwt_expiry = "1h"\n[db.migrations]\nschema_paths = "./schemas"\n',
      });
      expect(supabaseConfig(cwd)).toStrictEqual({});
    });
  });

  describe("PD045 unparseable config.toml", () => {
    it("warns once and lets the other checks fall back to defaults", () => {
      const cwd = project({
        "supabase/config.toml": "[auth\njwt_expiry = 1\n",
      });
      const findings = pd045(cwd);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe("PD045");
      expect(findings[0]?.message).toMatch(
        /^supabase\/config\.toml does not parse: /u,
      );
      expect(supabaseConfig(cwd)).toStrictEqual({});
    });

    it("is silent for a valid file or none", () => {
      expect(pd045(project({}))).toStrictEqual([]);
      expect(
        pd045(project({ "supabase/config.toml": "[auth]\njwt_expiry = 1\n" })),
      ).toStrictEqual([]);
    });
  });

  describe("PD136 Supabase CLI floor", () => {
    const withCli = (version: string): string =>
      project({
        "package.json": "{}",
        "supabase/config.toml": "",
        "node_modules/supabase/package.json": JSON.stringify({
          name: "supabase",
          version,
        }),
      });

    it("names the 3.2.0 floor for an older installed CLI", () => {
      expect(pd136(withCli("2.119.0"))).toStrictEqual([
        expect.objectContaining({
          code: "PD136",
          message:
            "the project installs Supabase CLI 2.119.0; PermDock supports 3.2.0 and later",
        }),
      ]);
      expect(pd136(withCli("3.1.9"))).toHaveLength(1);
    });

    it("is silent from 3.2.0, without the package or without a Supabase project", () => {
      expect(pd136(withCli("3.2.0"))).toStrictEqual([]);
      expect(pd136(withCli("3.10.0-beta.1"))).toStrictEqual([]);
      expect(pd136(project({ "supabase/config.toml": "" }))).toStrictEqual([]);
      expect(
        pd136(
          project({
            "package.json": "{}",
            "node_modules/supabase/package.json": '{"version":"2.0.0"}',
          }),
        ),
      ).toStrictEqual([]);
    });
  });

  describe("PD074 custom access token hook in config.toml", () => {
    // SAFETY: only supabase.hook and rls.schema are read.
    const configured = { supabase: { hook: { memberships: [] } } } as never;
    // SAFETY: an empty config; pd074 reads only supabase.hook.
    const bare = {} as never;
    const URI = "pg-functions://postgres/permdock/custom_access_token_hook";

    it("warns when the table is missing or not enabled", () => {
      for (const toml of [
        "[auth]\njwt_expiry = 1\n",
        `[auth.hook.custom_access_token]\nenabled = false\nuri = "${URI}"\n`,
      ]) {
        const findings = pd074(
          project({ "supabase/config.toml": toml }),
          configured,
        );
        expect(findings.map((finding) => finding.code)).toStrictEqual([
          "PD074",
        ]);
        expect(findings[0]?.fix).toContain(URI);
      }
    });

    it("prints the fix in the format the project uses", () => {
      const findings = pd074(
        project({ "supabase/config.json": '{"auth": {}}' }),
        configured,
      );
      expect(findings[0]?.fix).toBe(
        `add to supabase/config.json:\n"auth": { "hook": { "custom_access_token": { "enabled": true, "uri": "${URI}" } } }`,
      );
    });

    it("warns when the uri names another function", () => {
      const cwd = project({
        "supabase/config.toml":
          '[auth.hook.custom_access_token]\nenabled = true\nuri = "pg-functions://postgres/public/other"\n',
      });
      expect(pd074(cwd, configured)[0]?.message).toContain("public/other");
    });

    it("is silent for a matching stanza, no hook, no config.toml or an unparseable one", () => {
      const ok = project({
        "supabase/config.toml": `[auth.hook.custom_access_token]\nenabled = true\nuri = "${URI}"\n`,
      });
      expect(pd074(ok, configured)).toStrictEqual([]);
      expect(pd074(ok, bare)).toStrictEqual([]);
      expect(pd074(project({}), configured)).toStrictEqual([]);
      expect(
        pd074(project({ "supabase/config.toml": "[auth\n" }), configured),
      ).toStrictEqual([]);
    });
  });
});
