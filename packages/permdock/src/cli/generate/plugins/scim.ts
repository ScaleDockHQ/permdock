import type { RlsDialect } from "../../types.ts";
import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

export type ScimPluginOptions = {
  readonly schema?: string;
  readonly dialect?: RlsDialect;
  readonly out?: string;
};

/** The SCIM directory tables. The SQL loads on emit. */
export function scim(options: ScimPluginOptions = {}): PermDockPlugin {
  const schema = options.schema ?? "permdock";
  const dialect = options.dialect ?? "supabase";
  const out =
    options.out ??
    (dialect === "supabase"
      ? `supabase/schemas/${schema}/scim.sql`
      : "permdock_scim.sql");
  return definePlugin({
    name: "scim",
    version: pluginVersion(),
    inputs: () => ({ files: [], options }),
    plan: () => [{ id: "schema", out }],
    emit: async (task) => {
      // Lazy: the directory SQL loads only when this plugin emits.
      const { scimSchemaSql } = await import("../../scim/generate.ts");
      return [
        { path: task.out, contents: `${scimSchemaSql({ schema, dialect })}\n` },
      ];
    },
  });
}
