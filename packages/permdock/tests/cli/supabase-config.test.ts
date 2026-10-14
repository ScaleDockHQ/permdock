import { afterAll, describe, expect, it } from "vitest";

import {
  pd045,
  readSupabaseConfig,
  supabaseConfig,
} from "../../src/cli/supabase-config.ts";
import {
  resolveSchemas,
  schemasRefusal,
} from "../../src/cli/supabase-schemas.ts";
import { project, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

describe("readSupabaseConfig", () => {
  it("is undefined without supabase/config.toml", () => {
    expect(readSupabaseConfig(project({}))).toBeUndefined();
    expect(supabaseConfig(project({}))).toEqual({});
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
    expect(readSupabaseConfig(cwd)).toEqual({
      ok: true,
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
    ).toEqual({ pgDelta: { enabled: true, schemaDir: "supabase/schemas" } });
    expect(
      supabaseConfig(
        project({
          "supabase/config.toml":
            '[experimental.pgdelta]\nenabled = true\ndeclarative_schema_path = "./db/declarative/"\n',
        }),
      ),
    ).toEqual({
      pgDelta: { enabled: true, schemaDir: "supabase/db/declarative" },
    });
    expect(
      supabaseConfig(
        project({
          "supabase/config.toml": "[experimental.pgdelta]\nenabled = false\n",
        }),
      ),
    ).toEqual({ pgDelta: { enabled: false, schemaDir: "supabase/schemas" } });
    expect(
      supabaseConfig(
        project({
          "supabase/config.toml": '[experimental.pgdelta]\nenabled = "yes"\n',
        }),
      ),
    ).toEqual({ pgDelta: { schemaDir: "supabase/schemas" } });
  });

  it("resolves the schema workflow: --schemas, then supabase.schemas, then enabled = false, else pg-delta", () => {
    const none = project({});
    expect(resolveSchemas(none, {})).toEqual({
      mode: "pg-delta",
      schemaDir: "supabase/schemas",
    });
    const off = project({
      "supabase/config.toml":
        '[experimental.pgdelta]\nenabled = false\ndeclarative_schema_path = "./db"\n',
    });
    expect(resolveSchemas(off, {})).toEqual({ mode: "migra" });
    expect(resolveSchemas(off, {}, "pg-delta")).toEqual({
      mode: "pg-delta",
      schemaDir: "supabase/db",
    });
    expect(
      resolveSchemas(off, { supabase: { schemas: "migrations" } }),
    ).toEqual({ mode: "migrations" });
    expect(
      resolveSchemas(none, { supabase: { schemas: "migra" } }, "migrations"),
    ).toEqual({ mode: "migrations" });
    expect(schemasRefusal("rls generate", "pg-delta")).toBeUndefined();
    expect(schemasRefusal("rls generate", undefined)).toBeUndefined();
    expect(schemasRefusal("rls generate", "flyway")).toBe(
      "rls generate --schemas must be pg-delta, migra, migrations (got flyway)",
    );
  });

  it("ignores values of the wrong type", () => {
    const cwd = project({
      "supabase/config.toml":
        '[auth]\njwt_expiry = "1h"\n[db.migrations]\nschema_paths = "./schemas"\n',
    });
    expect(supabaseConfig(cwd)).toEqual({});
  });
});

describe("PD045 unparseable config.toml", () => {
  it("warns once and lets the other checks fall back to defaults", () => {
    const cwd = project({ "supabase/config.toml": "[auth\njwt_expiry = 1\n" });
    const findings = pd045(cwd);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("PD045");
    expect(findings[0]?.message).toMatch(
      /^supabase\/config\.toml does not parse: /u,
    );
    expect(supabaseConfig(cwd)).toEqual({});
  });

  it("is silent for a valid file or none", () => {
    expect(pd045(project({}))).toEqual([]);
    expect(
      pd045(project({ "supabase/config.toml": "[auth]\njwt_expiry = 1\n" })),
    ).toEqual([]);
  });
});
