import { afterAll, describe, expect, it } from "vitest";

import {
  pd045,
  readSupabaseConfig,
  supabaseConfig,
} from "../../src/cli/supabase-config.ts";
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
    ).toEqual({ pgDelta: { schemaDir: "supabase/schemas" } });
    expect(
      supabaseConfig(
        project({
          "supabase/config.toml":
            '[experimental.pgdelta]\nenabled = true\ndeclarative_schema_path = "./db/declarative/"\n',
        }),
      ),
    ).toEqual({ pgDelta: { schemaDir: "supabase/db/declarative" } });
    expect(
      supabaseConfig(
        project({
          "supabase/config.toml": "[experimental.pgdelta]\nenabled = false\n",
        }),
      ),
    ).toEqual({});
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
