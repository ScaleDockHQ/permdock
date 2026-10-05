import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function rls(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: "rls",
      description: COMMAND_DESCRIPTIONS.rls,
    },
    args: {
      ...globalArgs,
      action: {
        type: "positional",
        required: false,
        description: "generate, import, verify or migrate",
      },
      target: {
        type: "enum",
        options: ["sql", "drizzle", "prisma"],
        description: "generate: output form",
      },
      dialect: {
        type: "enum",
        options: ["supabase", "neon", "guc"],
        description: "How the database reads the subject (default rls.dialect)",
      },
      out: { type: "string", description: "File to write", valueHint: "file" },
      from: {
        type: "string",
        description: "Module exporting the policy, instead of the config",
        valueHint: "module",
      },
      sql: {
        type: "string",
        description: "import / migrate: SQL file or folder to read",
        valueHint: "path",
      },
      db: {
        type: "string",
        description: "Postgres connection string",
        valueHint: "url",
      },
      fixtures: {
        type: "string",
        description: "verify: fixtures file",
        valueHint: "file",
      },
      schema: {
        type: "string",
        description: "import: schema library, or the helper schema",
        valueHint: "name",
      },
      memberships: {
        type: "string",
        description: "import: membership table",
        valueHint: "table",
      },
      format: {
        type: "string",
        description: "verify: node or pgtap",
        valueHint: "format",
      },
      emit: {
        type: "string",
        description: "Alias of --format",
        valueHint: "format",
      },
      rbac: {
        type: "enum",
        options: ["supabase"],
        description: "generate: scaffold the role tables for this provider",
      },
      "rbac-scaffold": {
        type: "boolean",
        description: "generate: scaffold the role tables",
      },
      "rbac-schema": {
        type: "string",
        description: "Schema for the scaffolded role tables",
        valueHint: "name",
      },
      authorize: {
        type: "string",
        description: "Where roles are read: 'jwt' or 'database'",
        valueHint: "mode",
      },
      check: {
        type: "boolean",
        description: "Exit 1 when the files on disk are stale; write nothing",
      },
      "skip-closures": {
        type: "boolean",
        description: "Skip grants with closures instead of failing",
      },
      "inline-functions": {
        type: "boolean",
        description: "Inline helper calls into the policies",
      },
      force: { type: "boolean", description: "Overwrite an existing file" },
      "guc-prefix": {
        type: "string",
        description: "guc dialect: setting prefix",
        valueHint: "prefix",
      },
      "policy-per-role": {
        type: "boolean",
        description: "One policy per role instead of one per command",
      },
      "policy-name": {
        type: "string",
        description: "Policy name template",
        valueHint: "template",
      },
      "tenant-type": {
        type: "string",
        description: "Postgres type of the tenant column",
        valueHint: "type",
      },
      "custom-roles": {
        type: "boolean",
        description: "Emit the custom role tables and helpers",
      },
      capabilities: {
        type: "boolean",
        description: "Emit the link capability helpers",
      },
      fields: {
        type: "string",
        description: "Field security: 'views'",
        valueHint: "mode",
      },
      "revoke-columns": {
        type: "boolean",
        description: "Revoke restricted columns on the table",
      },
      tree: {
        type: "boolean",
        description: "verify: check the relationship closure",
      },
      introspect: {
        type: "boolean",
        description: "verify: compare against the live database",
      },
      split: {
        type: "string",
        description:
          "Write helpers, seeds, policies and hook as separate parts",
        valueHint: "parts",
      },
      "grants-out": {
        type: "string",
        description: "File for the helper and hook grants db diff drops",
        valueHint: "file",
      },
      "seeds-out": {
        type: "string",
        description: "File for the role_permissions seeds",
        valueHint: "file",
      },
      "helpers-only": {
        type: "boolean",
        description: "Write the helpers and keep the policies hand-written",
      },
      shims: {
        type: "boolean",
        description: "Wrap each rls.migrate helper under its legacy name",
      },
      write: {
        type: "boolean",
        description: "migrate: rewrite the files instead of a dry run",
      },
    },
    async run({ args: parsed }) {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const result = await (
        await import("../rls.ts")
      ).runRls({
        cwd: ctx.cwd,
        config: ctx.config,
        rest: parsed._,
        target: parsed.target,
        dialect: parsed.dialect,
        out: stringArg(parsed.out),
        from: stringArg(parsed.from),
        sql: stringArg(parsed.sql),
        db: stringArg(parsed.db),
        fixtures: stringArg(parsed.fixtures),
        schema: stringArg(parsed.schema),
        memberships: stringArg(parsed.memberships),
        format: stringArg(parsed.format) ?? stringArg(parsed.emit),
        rbac: parsed["rbac-scaffold"] === true || parsed.rbac === "supabase",
        rbacSchema: stringArg(parsed["rbac-schema"]),
        authorize: stringArg(parsed.authorize),
        check: parsed.check === true,
        skipClosures: parsed["skip-closures"] === true,
        inlineFunctions: parsed["inline-functions"] === true,
        force: parsed.force === true,
        gucPrefix: stringArg(parsed["guc-prefix"]),
        policyPerRole: parsed["policy-per-role"] === true,
        policyName: stringArg(parsed["policy-name"]),
        tenantType: stringArg(parsed["tenant-type"]),
        customRoles: parsed["custom-roles"] === true,
        capabilities: parsed.capabilities === true,
        fields: stringArg(parsed.fields),
        revokeColumns: parsed["revoke-columns"] === true,
        tree: parsed.tree === true,
        introspect: parsed.introspect === true,
        split: stringArg(parsed.split),
        grantsOut: stringArg(parsed["grants-out"]),
        seedsOut: stringArg(parsed["seeds-out"]),
        helpersOnly: parsed["helpers-only"] === true,
        shims: parsed.shims === true,
        write: parsed.write === true,
        json: ctx.json,
        io: ctx.io,
      });
      ctx.report(result);
    },
  });
  return command;
}
