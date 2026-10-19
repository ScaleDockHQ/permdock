import type { FlagValues } from "../core/command.ts";
import type { CliContext } from "../core/context.ts";
import type { CommandResult } from "../core/result.ts";
import type { RlsRunInput } from "../rls/rls.ts";

import { type Leaf, defineLeaf } from "../core/command.ts";
import { missingInput } from "../core/errors.ts";
import {
  checkFlag,
  dbUrl,
  dbUrlFlags,
  dryRunFlag,
  given,
  outFlag,
  policyFlag,
  validatorFlag,
} from "../core/flags.ts";

const membershipsFlag = {
  memberships: {
    type: "string",
    description: "Membership table as <table>:tenant,user,role",
    valueHint: "table",
  },
} as const;

/** The flags that shape the generated SQL; verify --introspect and migrate take them too. */
const shapeFlags = {
  target: {
    type: "enum",
    options: ["sql", "drizzle", "prisma"],
    default: "sql",
    description: "Output form",
  },
  dialect: {
    type: "enum",
    options: ["supabase", "neon", "guc"],
    description:
      "How the database reads the subject (default rls.dialect, else supabase)",
  },
  ...policyFlag,
  ...membershipsFlag,
  rbac: {
    type: "enum",
    options: ["supabase"],
    description: "Scaffold the role tables for this provider",
  },
  "rbac-schema": {
    type: "string",
    description: "Schema for the scaffolded role tables",
    valueHint: "name",
  },
  authorize: {
    type: "enum",
    options: ["database", "jwt"],
    description: "Where roles are read",
  },
  "skip-closures": {
    type: "boolean",
    description: "Skip grants with closures instead of failing",
  },
  "inline-functions": {
    type: "boolean",
    description: "Inline helper calls into the policies",
  },
  "force-rls": {
    type: "boolean",
    description:
      "Emit FORCE ROW LEVEL SECURITY so the table owner is held to the policies",
  },
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
  fields: { type: "enum", options: ["views"], description: "Field security" },
  "revoke-columns": {
    type: "boolean",
    description: "Revoke restricted columns on the table",
  },
  "helpers-only": {
    type: "boolean",
    description: "Write the helpers and keep the policies hand-written",
  },
  shims: {
    type: "boolean",
    description: "Wrap each rls.migrate helper under its legacy name",
  },
  schemas: {
    type: "enum",
    options: ["pg-delta", "migra", "migrations"],
    description: "Schema workflow (default supabase.schemas, else pg-delta)",
  },
  ...dbUrlFlags,
} as const;

const sqlFlag = {
  sql: {
    type: "string",
    description: "SQL file or folder to read",
    valueHint: "path",
  },
} as const;

type ShapeValues = FlagValues<typeof shapeFlags>;

const SHAPE_DEFAULTS: ShapeValues = {
  target: "sql",
  dialect: undefined,
  policy: undefined,
  memberships: undefined,
  rbac: undefined,
  "rbac-schema": undefined,
  authorize: undefined,
  "skip-closures": false,
  "inline-functions": false,
  "force-rls": false,
  "guc-prefix": undefined,
  "policy-per-role": false,
  "policy-name": undefined,
  "tenant-type": undefined,
  "custom-roles": false,
  capabilities: false,
  fields: undefined,
  "revoke-columns": false,
  "helpers-only": false,
  shims: false,
  schemas: undefined,
  "db-url": undefined,
  "db-url-stdin": false,
};

/** Every RlsRunInput field at its "not given" value, with the shape flags applied. */
async function rlsInput(
  ctx: CliContext,
  verb: string,
  shape: ShapeValues,
  options?: { readonly dbRequired?: boolean },
): Promise<RlsRunInput> {
  return {
    cwd: ctx.cwd,
    config: ctx.config,
    rest: [verb],
    target: shape.target,
    dialect: shape.dialect,
    out: undefined,
    from: given(shape.policy),
    sql: undefined,
    db: await dbUrl(ctx, shape, { required: options?.dbRequired === true }),
    fixtures: undefined,
    schema: undefined,
    memberships: given(shape.memberships),
    format: undefined,
    rbac: shape.rbac === "supabase",
    rbacSchema: given(shape["rbac-schema"]),
    authorize: shape.authorize,
    check: false,
    skipClosures: shape["skip-closures"],
    inlineFunctions: shape["inline-functions"],
    force: shape["force-rls"],
    gucPrefix: given(shape["guc-prefix"]),
    policyPerRole: shape["policy-per-role"],
    policyName: given(shape["policy-name"]),
    tenantType: given(shape["tenant-type"]),
    customRoles: shape["custom-roles"],
    capabilities: shape.capabilities,
    fields: shape.fields,
    revokeColumns: shape["revoke-columns"],
    tree: false,
    introspect: false,
    split: undefined,
    schemas: shape.schemas,
    grantsOut: undefined,
    seedsOut: undefined,
    helpersOnly: shape["helpers-only"],
    shims: shape.shims,
    write: false,
    json: ctx.json,
    io: ctx.io,
  };
}

async function runRls(input: RlsRunInput): Promise<CommandResult> {
  // Lazy: the implementation loads only when this command runs, not for --help.
  return (await import("../rls/rls.ts")).runRls(input);
}

export const generate: Leaf = defineLeaf({
  flags: {
    ...shapeFlags,
    ...outFlag,
    ...checkFlag,
    project: {
      type: "string",
      description:
        "Rebuild the policy from a PermDock Cloud project's pushed catalog and policy",
      valueHint: "id",
    },
    url: {
      type: "string",
      description: "With --project: Cloud API base URL",
      valueHint: "url",
    },
    split: {
      type: "string",
      description:
        "Write helpers, seeds, indexes, policies and hook as separate parts",
      valueHint: "parts",
    },
    "grants-out": {
      type: "string",
      description: "migra: file for the privileges supabase db diff drops",
      valueHint: "file",
    },
    "seeds-out": {
      type: "string",
      description: "File for the role_permissions seeds",
      valueHint: "file",
    },
    "backfill-out": {
      type: "string",
      description: "File for the rls.customRoles.from copy",
      valueHint: "file",
    },
  },
  async run(ctx, { flags }) {
    const backfillOut = given(flags["backfill-out"]);
    return runRls({
      ...(await rlsInput(ctx, "generate", flags)),
      out: given(flags.out),
      check: flags.check,
      project: given(flags.project),
      url: given(flags.url),
      split: given(flags.split),
      grantsOut: given(flags["grants-out"]),
      seedsOut: given(flags["seeds-out"]),
      ...(backfillOut === undefined ? {} : { backfillOut }),
    });
  },
});

export const importPolicies: Leaf = defineLeaf({
  flags: {
    ...sqlFlag,
    ...dbUrlFlags,
    ...outFlag,
    ...validatorFlag,
    ...membershipsFlag,
  },
  async run(ctx, { flags }) {
    const sql = given(flags.sql);
    const db = await dbUrl(ctx, flags, { required: sql === undefined });
    if (sql === undefined && db === undefined) {
      throw missingInput(
        "rls import",
        ["--sql", "--db-url"],
        "pass one, or set DATABASE_URL",
      );
    }
    return runRls({
      ...(await rlsInput(ctx, "import", {
        ...SHAPE_DEFAULTS,
        memberships: flags.memberships,
      })),
      sql,
      db,
      out: given(flags.out),
      schema: flags.validator,
    });
  },
});

export const verify: Leaf = defineLeaf({
  flags: {
    ...shapeFlags,
    fixtures: {
      type: "string",
      description: "Fixtures file",
      valueHint: "file",
    },
    kind: {
      type: "enum",
      options: ["node", "pgtap"],
      description: "Run the fixtures in Node or emit a pgTAP file",
    },
    tree: { type: "boolean", description: "Check the relationship closure" },
    introspect: {
      type: "boolean",
      description: "Compare against the live database",
    },
    advisors: {
      type: "boolean",
      description: "Run the Supabase security advisors",
    },
  },
  async run(ctx, { flags }) {
    return runRls({
      ...(await rlsInput(ctx, "verify", flags, {
        dbRequired: flags.introspect,
      })),
      fixtures: given(flags.fixtures),
      format: flags.kind,
      tree: flags.tree,
      introspect: flags.introspect,
      advisors: flags.advisors,
    });
  },
});

export const migrate: Leaf = defineLeaf({
  flags: {
    ...shapeFlags,
    ...sqlFlag,
    ...dryRunFlag,
    force: {
      type: "boolean",
      description: "Rewrite files with uncommitted changes too",
    },
    "retire-out": {
      type: "string",
      description:
        "File dropping the rls.migrate.tables once nothing reads them",
      valueHint: "file",
    },
  },
  async run(ctx, { flags }) {
    const sql = given(flags.sql);
    if (sql === undefined) {
      throw missingInput(
        "rls migrate",
        ["--sql"],
        "the folder of SQL files to rewrite",
      );
    }
    const retireOut = given(flags["retire-out"]);
    return runRls({
      ...(await rlsInput(ctx, "migrate", flags)),
      sql,
      write: !flags["dry-run"],
      forceRewrite: flags.force,
      ...(retireOut === undefined ? {} : { retireOut }),
    });
  },
});
