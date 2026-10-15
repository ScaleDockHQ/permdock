import type { FeatureId, Preset } from "./catalog.ts";
import type {
  DomainSpec,
  GrantSpec,
  ResourceSpec,
  RoleSpec,
} from "./domain.ts";

import { encodePreset } from "./codec.ts";
import { DOMAINS } from "./domain.ts";

/** One file the preset writes into the application, relative to its root. */
export type GeneratedFile = {
  readonly path: string;
  readonly contents: string;
  /**
   * `owned`: the application's own code, edited freely and never
   * rewritten by an update. Every generated file is owned; rules, checks and
   * verification stay in the `permdock` package, which these files only call.
   */
  readonly kind: "owned";
};

export type GeneratedPreset = {
  readonly code: string;
  readonly files: readonly GeneratedFile[];
  /** Packages to add with the application's package manager. */
  readonly dependencies: readonly string[];
  /** `@permdock` registry items to add with `npx shadcn@latest add`. */
  readonly recipes: readonly string[];
  /** Pages to read next, as `/docs` paths. */
  readonly docs: readonly string[];
};

type Context = {
  readonly preset: Preset;
  readonly domain: DomainSpec;
  readonly has: (feature: FeatureId) => boolean;
  /** The source directory, `src`. */
  readonly src: string;
};

const LIMIT = "{ count: 100, per: 86_400 }";

// Built from parts so this runtime chunk carries no `process.` token, which
// the WinterTC check reads as a Node global; the generated file has it whole.
const NODE_ENV = ["process", 'env["NODE_ENV"]'].join(".");

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function fieldsOf(ctx: Context, resource: ResourceSpec): [string, string][] {
  const fields: [string, string][] = [
    ["id", "z.string()"],
    ...Object.entries(resource.fields),
  ];
  if (ctx.has("tenancy")) {
    fields.push(["orgId", "z.string()"]);
  }
  return fields;
}

function permissionsFile(ctx: Context): string {
  const schemas = ctx.domain.resources.map((resource) => {
    const fields = fieldsOf(ctx, resource)
      .map(([name, type]) => `  ${name}: ${type},`)
      .join("\n");
    return `export const ${pascal(resource.name)} = z.object({\n${fields}\n});\nexport type ${pascal(resource.name)} = z.infer<typeof ${pascal(resource.name)}>;`;
  });
  const entries = ctx.domain.resources.map((resource) => {
    const extra = [
      ...(resource.actions === undefined || resource.actions.length === 0
        ? []
        : [`actions: [${resource.actions.map(quote).join(", ")}]`]),
      ...(resource.collection === undefined || resource.collection.length === 0
        ? []
        : [`collection: [${resource.collection.map(quote).join(", ")}]`]),
    ];
    const relations = ctx.has("tenancy")
      ? [`relations: { org: { field: "orgId", memberOf: "tenant" } }`]
      : [];
    const options = [`id: "id"`, ...relations, ...extra].join(", ");
    return `  ${resource.name}: resource(${pascal(resource.name)}, ${resource.preset}({ ${options} })),`;
  });
  const presets = [
    ...new Set(ctx.domain.resources.map((resource) => resource.preset)),
  ].toSorted();
  return `import { definePermissions, ${presets.join(", ")}, resource } from "permdock";
import { z } from "zod";

${schemas.join("\n\n")}

export const permissions = definePermissions({
${entries.join("\n")}
});
`;
}

/** What a role's grant becomes under the preset's features; the matrix and the code read the same answer. */
export function grantShape(
  preset: Preset,
  role: RoleSpec,
  grant: GrantSpec,
): {
  readonly owner: string | undefined;
  readonly approval: boolean;
  readonly limit: boolean;
} {
  const has = (feature: FeatureId): boolean =>
    preset.features.includes(feature);
  const resource = DOMAINS[preset.archetype].resources.find(
    (item) => item.name === grant.resource,
  );
  const risky =
    grant.action === "delete" ||
    (resource?.sensitive ?? []).includes(grant.action);
  return {
    owner: grant.own === true && has("ownership") ? resource?.owner : undefined,
    approval: has("approvals") && risky && role.top !== true,
    limit:
      has("limits") &&
      role.name === DOMAINS[preset.archetype].demoRole &&
      grant.action === "create",
  };
}

function grantLine(ctx: Context, role: RoleSpec, grant: GrantSpec): string {
  const shape = grantShape(ctx.preset, role, grant);
  const options: string[] = [];
  if (shape.owner !== undefined) {
    options.push(`where: { ${shape.owner}: principal.id }`);
  }
  if (shape.approval) {
    options.push(`approval: "human"`);
  }
  if (shape.limit) {
    options.push(`limit: ${LIMIT}`);
  }
  const target = `permissions.${grant.resource}.${grant.action}`;
  return options.length === 0
    ? `allow(${target})`
    : `allow(${target}, { ${options.join(", ")} })`;
}

function isPro(ctx: Context, grant: GrantSpec): boolean {
  const pro = ctx.domain.pro;
  return (
    ctx.has("plans") &&
    pro !== undefined &&
    grant.resource === pro.resource &&
    grant.action === pro.action
  );
}

function policyFile(ctx: Context): string {
  const tenancy = ctx.has("tenancy");
  const roles = ctx.domain.roles.map((role) => {
    const grants = role.grants
      .filter((grant) => role.top === true || !isPro(ctx, grant))
      .map((grant) => `    ${grantLine(ctx, role, grant)},`)
      .join("\n");
    const options: string[] = [];
    if (tenancy) {
      options.push(`on: "tenant"`);
      if (role.top === true) {
        options.push("min: 1");
      }
      if (role.assigns !== undefined) {
        options.push(`assigns: [${role.assigns.map(quote).join(", ")}]`);
      }
    }
    const tail = options.length === 0 ? "" : `, { ${options.join(", ")} }`;
    return `  role("${role.name}", [\n${grants}\n  ]${tail}),`;
  });
  const pro = ctx.domain.pro;
  const proGrant =
    ctx.has("plans") && pro !== undefined
      ? `  grants: [allow(permissions.${pro.resource}.${pro.action}, { to: plan("pro") })],\n`
      : "";
  const usesPrincipal =
    ctx.has("ownership") &&
    ctx.domain.roles.some((role) => role.grants.some((grant) => grant.own));
  const imports = [
    "allow",
    "definePolicy",
    ...(ctx.has("plans") ? ["plan"] : []),
    ...(usesPrincipal ? ["principal"] : []),
    "role",
  ];
  const userFields = [
    "  readonly id: string;",
    "  readonly roles: readonly string[];",
    ...(tenancy ? ["  readonly orgId: string;"] : []),
    ...(ctx.has("plans") ? ["  readonly plans: readonly string[];"] : []),
  ];
  const principalFields = [
    "id: user.id",
    ...(tenancy
      ? [
          "tenant: user.orgId",
          `memberships: [{ scope: "tenant", id: user.orgId, roles: user.roles }]`,
        ]
      : ["roles: user.roles"]),
    ...(ctx.has("plans") ? ["plans: user.plans"] : []),
  ];
  const demo = [
    `id: "u1"`,
    `roles: ["${ctx.domain.demoRole}"]`,
    ...(tenancy ? [`orgId: "o1"`] : []),
    ...(ctx.has("plans") ? [`plans: ["free"]`] : []),
  ];
  return `import { ${imports.join(", ")} } from "permdock";

import { permissions } from "./permissions";

/** The signed-in user as your session or auth provider returns it. */
export type User = {
${userFields.join("\n")}
};

export const policy = definePolicy(permissions, {
${tenancy ? `  scopes: { tenant: { key: "orgId" } },\n` : ""}  roles: [
${roles.join("\n")}
  ],
${proGrant}  subject: (user: User | null) =>
    user === null ? null : { ${principalFields.join(", ")} },
});

/** A user for tests and local runs. */
export const demoUser: User = { ${demo.join(", ")} };
`;
}

function appFile(ctx: Context): string {
  const valueImports = new Set<string>(["defineApp"]);
  const lines: string[] = [];
  const preamble: string[] = [];
  const services = ctx.preset.services;
  const cloudServices = services.length > 0;
  if (cloudServices) {
    preamble.push(`import { cloud } from "permdock/cloud";`);
  }
  if (services.includes("cloud-hosted-grants")) {
    preamble.push(
      `import { cloudEndpoints } from "permdock/cloud";`,
      `import { joseTokenVerifier } from "permdock/jwt";`,
    );
  }
  if (ctx.has("audit")) {
    if (services.includes("cloud-decision-log")) {
      lines.push("  sink: permdockCloud.sink,");
    } else {
      valueImports.add("memoryDecisionSink");
      lines.push(
        "  // A DecisionSink: memory for now; permdock/otel, PermDock Cloud or your own in production.",
        "  sink: memoryDecisionSink(),",
      );
    }
  }
  if (ctx.has("custom-roles")) {
    valueImports.add("memoryCustomRoleSource");
    lines.push(
      "  // Custom roles from your database; postgrestSources() reads them on Supabase.",
      "  customRoles: memoryCustomRoleSource([]),",
    );
  }
  if (services.includes("cloud-approvals")) {
    lines.push("  store: permdockCloud.approvals,");
  } else if (ctx.has("approvals")) {
    lines.push(
      "  // profile dev uses a memory ApprovalStore; set a persistent one (Postgres, PermDock Cloud) for prod.",
    );
  }
  if (ctx.has("limits")) {
    valueImports.add("limits");
    valueImports.add("memoryLimitStore");
    lines.push(
      "  // A memory LimitStore counts per process; set a shared one (Redis, Postgres) for prod.",
      "  limits: limits(memoryLimitStore()),",
    );
  }
  if (services.includes("cloud-hosted-grants")) {
    valueImports.add("hostedPolicies");
    lines.push("  policies: hostedPolicies(permdockCloud.policies),");
  }
  const cloudCall = services.includes("cloud-hosted-grants")
    ? `cloud({\n  verifier: joseTokenVerifier({ jwks: cloudEndpoints().jwks }),\n})`
    : "cloud()";
  const cloudLine = cloudServices
    ? `\n// PERMDOCK_CLOUD_URL and PERMDOCK_CLOUD_KEY come from the environment.\nexport const permdockCloud = ${cloudCall};\n`
    : "";
  return `import { ${[...valueImports].toSorted().join(", ")} } from "permdock";
${preamble.length === 0 ? "" : `${preamble.join("\n")}\n`}
import { policy } from "./policy";
${cloudLine}
/**
 * The app definition every adapter reads. Your own code: change sources,
 * features and services here; the rules stay in the permdock package.
 */
export const app = defineApp(policy, {
  profile: ${NODE_ENV} === "production" ? "prod" : "dev",
${lines.join("\n")}${lines.length === 0 ? "" : "\n"}});
`;
}

function dataFile(ctx: Context): string {
  const tenancy = ctx.has("tenancy");
  const blocks = ctx.domain.resources.map((resource) => {
    const type = pascal(resource.name);
    const row = fieldsOf(ctx, resource)
      .map(([name, kind]) => {
        if (name === "id") {
          return `id: "${resource.name}_1"`;
        }
        if (name === "orgId") {
          return `orgId: "o1"`;
        }
        if (name === resource.owner) {
          return `${name}: "u1"`;
        }
        return kind.startsWith("z.number") ? `${name}: 1` : `${name}: ""`;
      })
      .join(", ");
    return `const ${resource.name}Rows = new Map<string, ${type}>([
  ["${resource.name}_1", { ${row} }],
]);

/** Replace with your database read. */
export function find${type}(id: string): ${type} | null {
  return ${resource.name}Rows.get(id) ?? null;
}`;
  });
  const types = ctx.domain.resources.map((resource) => pascal(resource.name));
  return `import type { ${types.join(", ")} } from "./permissions";

${tenancy ? "// Demo rows in organisation o1, owned by the demo user u1.\n" : "// Demo rows owned by the demo user u1.\n"}${blocks.join("\n\n")}
`;
}

function sessionFile(ctx: Context): string {
  const provider: Record<Preset["auth"], string> = {
    custom: "your session",
    supabase: "Supabase Auth (subjectFromSupabase, /docs/adapters/supabase)",
    "better-auth":
      "Better Auth (subjectFromBetterAuth, /docs/adapters/better-auth)",
    clerk: "Clerk (subjectFromClerk, /docs/adapters/clerk)",
    jwt: "your OIDC provider (subjectFromJwt, /docs/adapters/jwt)",
  };
  return `import type { User } from "./policy";

/**
 * The signed-in user, read from ${provider[ctx.preset.auth]}.
 * It returns null until you wire it, so every check fails closed.
 */
export async function currentUser(): Promise<User | null> {
  return null;
}
`;
}

function firstInstance(ctx: Context): {
  readonly resource: ResourceSpec;
  readonly action: string;
} {
  const [resource] = ctx.domain.resources;
  if (resource === undefined) {
    throw new Error("PermDock: a preset domain declares at least one resource");
  }
  return { resource, action: "update" };
}

function ownedFile(path: string, contents: string): GeneratedFile {
  return { path, contents, kind: "owned" };
}

function frameworkFiles(ctx: Context): GeneratedFile[] {
  const { resource, action } = firstInstance(ctx);
  const type = pascal(resource.name);
  const owned = ownedFile;
  switch (ctx.preset.framework) {
    case "next":
      return [
        owned(
          `${ctx.src}/permdock/server.ts`,
          `import { createPermDock } from "permdock/next";

import { app } from "../permdock";
import { currentUser } from "../session";

// Server-only: Server Components, Server Actions and Route Handlers import
// from here; client components import hooks from permdock/react.
export const {
  getPermDock,
  getPermission,
  getSnapshot,
  requireAccess,
  permdockHandler,
} = createPermDock(app, { subject: currentUser });
`,
        ),
      ];
    case "hono":
      return [
        owned(
          `${ctx.src}/server.ts`,
          `import { Hono } from "hono";
import { createPermDock } from "permdock/hono";

import { find${type} } from "./data";
import { app as permdockApp } from "./permdock";
import { permissions } from "./permissions";
import { currentUser } from "./session";

const { protect } = createPermDock(permdockApp, {
  subject: () => currentUser(),
});

export const app = new Hono();

app.patch(
  "/${resource.name}s/:id",
  protect(permissions.${resource.name}.${action}, (c) => find${type}(c.req.param("id") ?? "")),
  (c) => c.json({ ok: true }),
);
`,
        ),
      ];
    case "express":
      return [
        owned(
          `${ctx.src}/server.ts`,
          `import express from "express";
import { createPermDock } from "permdock/express";

import { find${type} } from "./data";
import { app as permdockApp } from "./permdock";
import { permissions } from "./permissions";
import { currentUser } from "./session";

const { protect } = createPermDock(permdockApp, {
  subject: () => currentUser(),
});

export const app = express();

app.patch(
  "/${resource.name}s/:id",
  protect(permissions.${resource.name}.${action}, (req) => find${type}(String(req.params["id"]))),
  (_req, res) => {
    res.json({ ok: true });
  },
);
`,
        ),
      ];
    case "none":
      return [
        owned(
          `${ctx.src}/server.ts`,
          `import { createPermDock } from "permdock";

import { app } from "./permdock";
import type { User } from "./policy";

/** The request-scoped decision object for \`user\`; create one per request. */
export function permdockFor(user: User | null) {
  return createPermDock(app, user);
}
`,
        ),
      ];
    default: {
      const exhaustive: never = ctx.preset.framework;
      return exhaustive;
    }
  }
}

function operationsFile(ctx: Context): string {
  const entries = ctx.domain.resources.flatMap((resource) => {
    const type = pascal(resource.name);
    const ops = [
      `  list_${resource.name}s: { permission: permissions.${resource.name}.list },`,
    ];
    if (resource.preset === "crud") {
      ops.push(
        `  delete_${resource.name}: {\n    permission: permissions.${resource.name}.delete,\n    data: (input: { readonly id: string }) => find${type}(input.id),\n  },`,
      );
    }
    for (const action of resource.collection ?? []) {
      ops.push(
        `  ${action}_${resource.name}: { permission: permissions.${resource.name}.${action} },`,
      );
    }
    return ops;
  });
  const finds = ctx.domain.resources
    .filter((resource) => resource.preset === "crud")
    .map((resource) => `find${pascal(resource.name)}`);
  return `import { defineOperations } from "permdock";

${finds.length === 0 ? "" : `import { ${finds.join(", ")} } from "./data";\n`}import { permissions } from "./permissions";

/** The tools an agent may call, each bound to one permission. */
export const operations = defineOperations(permissions, {
${entries.join("\n")}
});
`;
}

function agentFiles(ctx: Context): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  if (!ctx.has("agents")) {
    return files;
  }
  files.push({
    path: `${ctx.src}/operations.ts`,
    contents: operationsFile(ctx),
    kind: "owned",
  });
  if (ctx.preset.agents.includes("ai-sdk")) {
    files.push({
      path: `${ctx.src}/agent.ts`,
      contents: `import { createPermDock } from "permdock/ai-sdk";

import { operations } from "./operations";
import { app } from "./permdock";
import { currentUser } from "./session";

// Pass toolApproval to the AI SDK's tool approval hook, or needsApproval to each tool.
export const { toolApproval, needsApproval, capabilityMiddleware } =
  createPermDock(app, {
    subject: () => currentUser(),
    actor: () => ({ id: "assistant", kind: "ai-sdk" }),
    operations,
  });
`,
      kind: "owned",
    });
  }
  if (ctx.preset.agents.includes("mcp")) {
    files.push({
      path: `${ctx.src}/mcp.ts`,
      contents: `import { createPermDock } from "permdock/mcp";

import { app } from "./permdock";
import type { User } from "./policy";

/** Map the verified MCP auth info to your user; null is anonymous. */
function userFor(_authInfo: unknown): User | null {
  return null;
}

// protectServer(new McpServer(...)) returns a server whose registerTool takes a permission.
export const { protectServer } = createPermDock(app, {
  subject: (authInfo) => userFor(authInfo),
});
`,
      kind: "owned",
    });
  }
  return files;
}

function keysFile(ctx: Context): GeneratedFile[] {
  if (!ctx.has("api-keys")) {
    return [];
  }
  const { resource } = firstInstance(ctx);
  return [
    {
      path: `${ctx.src}/keys.ts`,
      contents: `import { type PermDock, decideCredential } from "permdock";

import { permissions } from "./permissions";

/**
 * Decides whether the signed-in user may create a read-only key for
 * ${resource.name}s${ctx.has("tenancy") ? " in their organisation" : ""}. Store the granted credential's hash; show the
 * key once.
 */
export function decideReadKey(permdock: PermDock, id: string) {
  return decideCredential(permdock, {
    kind: "service",
    id,
    principal: \`service:\${id}\`,
    tenant: permdock.subject.principal?.tenant ?? "",
    roles: ["${ctx.domain.demoRole}"],
    permissions: [permissions.${resource.name}.read, permissions.${resource.name}.list],
    name: "read-only key",
  });
}
`,
      kind: "owned",
    },
  ];
}

function configFile(ctx: Context): GeneratedFile[] {
  if (!ctx.has("rls")) {
    return [];
  }
  const table = `{\n      table: "org_members",\n      tenant: "org_id",\n      user: "user_id",\n      role: "role",\n    }`;
  // Plain Postgres reads the user from a GUC set per transaction; Supabase reads auth.uid().
  const rls =
    ctx.preset.backend === "supabase"
      ? `supabaseRls({${ctx.has("tenancy") ? `\n    memberships: ${table},\n  ` : ""}})`
      : `{\n    dialect: "guc",${ctx.has("tenancy") ? `\n    memberships: { tenant: ${table} },` : ""}\n  }`;
  return [
    {
      path: "permdock.config.ts",
      contents: `import { defineConfig } from "permdock/cli";
${ctx.preset.backend === "supabase" ? `import { supabaseRls } from "permdock/supabase";\n` : ""}
// \`permdock rls generate\` writes RLS policies from the same policy as the app.
export default defineConfig({
  permissions: "./${ctx.src}/permissions.ts",
  policy: "./${ctx.src}/policy.ts",
  rls: ${rls},
});
`,
      kind: "owned",
    },
  ];
}

/** The `@permdock` registry recipes for the preset's UI; native has the gate and the upgrade prompt. */
function recipesFor(ctx: Context): string[] {
  const web = ["gated-button"];
  if (ctx.has("approvals")) {
    web.push("approval-request-dialog");
  }
  if (ctx.has("tenancy")) {
    web.push("tenant-switcher", "role-picker");
  }
  if (ctx.has("custom-roles")) {
    web.push("custom-role-editor");
  }
  if (ctx.has("plans")) {
    web.push("upgrade-prompt");
  }
  const native = [
    "gated-button",
    ...(ctx.has("plans") ? ["upgrade-prompt"] : []),
  ];
  return [
    ...(ctx.preset.ui.includes("shadcn")
      ? web.map((name) => `@permdock/${name}`)
      : []),
    ...(ctx.preset.ui.includes("react-native")
      ? native.map((name) => `@permdock/${name}-native`)
      : []),
  ];
}

function dependenciesFor(ctx: Context): string[] {
  const deps = ["permdock", "zod"];
  const framework: Record<Preset["framework"], readonly string[]> = {
    next: ["next", "react", "react-dom"],
    hono: ["hono"],
    express: ["express"],
    none: [],
  };
  deps.push(...framework[ctx.preset.framework]);
  if (ctx.preset.agents.includes("ai-sdk")) {
    deps.push("ai");
  }
  if (ctx.preset.agents.includes("mcp")) {
    deps.push("@modelcontextprotocol/server");
  }
  if (ctx.preset.services.includes("cloud-hosted-grants")) {
    deps.push("jose");
  }
  return deps;
}

function docsFor(ctx: Context): string[] {
  const docs = ["/docs/concepts/apps", "/docs/concepts/policies"];
  const byFeature: Partial<Record<FeatureId, string>> = {
    tenancy: "/docs/concepts/tenancy",
    "custom-roles": "/docs/concepts/custom-roles",
    approvals: "/docs/adapters/approvals",
    agents: "/docs/concepts/operations",
    audit: "/docs/concepts/audit-and-observability",
    "api-keys": "/docs/concepts/credentials",
    rls: "/docs/adapters/rls",
  };
  for (const feature of ctx.preset.features) {
    const page = byFeature[feature];
    if (page !== undefined) {
      docs.push(page);
    }
  }
  if (ctx.preset.framework !== "none") {
    docs.push(`/docs/adapters/${ctx.preset.framework}`);
  }
  return docs;
}

/**
 * The files, dependencies and recipes for `preset`. Pure: no file system
 * and no network, so the same function runs in the CLI, in a registry route
 * and in the browser preview on /create.
 */
export function generatePreset(
  preset: Preset,
  options: { readonly src?: string } = {},
): GeneratedPreset {
  const ctx: Context = {
    preset,
    domain: DOMAINS[preset.archetype],
    has: (feature) => preset.features.includes(feature),
    src: options.src ?? "src",
  };
  const owned = (path: string, contents: string): GeneratedFile =>
    ownedFile(`${ctx.src}/${path}`, contents);
  return Object.freeze({
    code: encodePreset(preset),
    files: Object.freeze([
      owned("permissions.ts", permissionsFile(ctx)),
      owned("policy.ts", policyFile(ctx)),
      owned("permdock.ts", appFile(ctx)),
      owned("data.ts", dataFile(ctx)),
      owned("session.ts", sessionFile(ctx)),
      ...frameworkFiles(ctx),
      ...agentFiles(ctx),
      ...keysFile(ctx),
      ...configFile(ctx),
    ]),
    dependencies: Object.freeze(dependenciesFor(ctx)),
    recipes: Object.freeze(recipesFor(ctx)),
    docs: Object.freeze(docsFor(ctx)),
  });
}
