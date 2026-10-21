import type { Leaf } from "./command.ts";

/**
 * What a command may touch. `files` writes files it owns, `rewrite` edits
 * files the project owns, `database:*` connects to Postgres, `network`
 * calls a remote service, `cloud:write` publishes to PermDock Cloud,
 * `install` runs a package manager. In agent mode `rewrite`, `cloud:write`
 * and `files` with `--force` need the person's consent.
 */
export type Effect =
  | "files"
  | "rewrite"
  | "database:read"
  | "database:write"
  | "network"
  | "cloud:write"
  | "install";

export type LeafEntry = {
  readonly kind: "leaf";
  readonly name: string;
  readonly summary: string;
  readonly examples: readonly string[];
  /** The page under https://permdock.com/docs/cli/ that documents it. */
  readonly docs: string;
  readonly effects: readonly Effect[];
  /** Reads permdock.config.ts; the config loads only for these. */
  readonly config: boolean;
  /** Reports findings, so `--format github` and `sarif` apply. */
  readonly findings?: boolean;
  /** Prints for a shell to read, so agent mode keeps text output unless `--json` asks. */
  readonly shellOutput?: boolean;
  readonly hidden?: boolean;
  readonly load: () => Promise<Leaf>;
};

export type GroupEntry = {
  readonly kind: "group";
  readonly name: string;
  readonly summary: string;
  readonly docs: string;
  readonly children: readonly Entry[];
};

export type Entry = LeafEntry | GroupEntry;

export type Section = {
  readonly title: string;
  readonly entries: readonly Entry[];
};

export const DOCS_BASE = "https://permdock.com/docs/cli";

function leaf(
  name: string,
  summary: string,
  options: Omit<LeafEntry, "kind" | "name" | "summary">,
): LeafEntry {
  return { kind: "leaf", name, summary, ...options };
}

function group(
  name: string,
  summary: string,
  docs: string,
  children: readonly Entry[],
): GroupEntry {
  return { kind: "group", name, summary, docs, children };
}

// Every load is a dynamic import so `permdock --help` and `--version` load no command module.
export const SECTIONS: readonly Section[] = [
  {
    title: "Get started",
    entries: [
      leaf(
        "init",
        "Write a preset's permissions, policy, app and wiring into the project",
        {
          examples: [
            "permdock init --preset p1AQIDBAc",
            "permdock init --archetype b2b --framework hono --integration mcp",
            "permdock init --archetype api --auth supabase --backend drizzle --service cloud-decision-log",
          ],
          docs: "init",
          effects: ["files"],
          config: false,
          load: async () => (await import("../commands/init.ts")).init,
        },
      ),
      group(
        "preset",
        "Decode a preset code, or print its permdock.com/create link",
        "preset",
        [
          leaf("decode", "Print what a preset code holds", {
            examples: ["permdock preset decode p1AQIDBAc"],
            docs: "preset",
            effects: [],
            config: false,
            load: async () =>
              (await import("../commands/init.ts")).presetDecode,
          }),
          leaf("url", "Print the permdock.com/create link that opens a code", {
            examples: ["permdock preset url p1AQIDBAc"],
            docs: "preset",
            effects: [],
            config: false,
            load: async () => (await import("../commands/init.ts")).presetUrl,
          }),
        ],
      ),
      group(
        "skills",
        "Install, update or list the PermDock Agent Skills",
        "skills",
        [
          leaf("install", "Copy the Agent Skills into the agent folders", {
            examples: [
              "permdock skills install",
              "permdock skills install --for cursor --for claude",
              "permdock skills install --check",
            ],
            docs: "skills",
            effects: ["files"],
            config: false,
            load: async () => (await import("../commands/skills.ts")).install,
          }),
          leaf("update", "Replace installed skills with this version's", {
            examples: ["permdock skills update"],
            docs: "skills",
            effects: ["files"],
            config: false,
            load: async () => (await import("../commands/skills.ts")).update,
          }),
          leaf("list", "List the skills and where each is installed", {
            examples: ["permdock skills list"],
            docs: "skills",
            effects: [],
            config: false,
            load: async () => (await import("../commands/skills.ts")).list,
          }),
        ],
      ),
      leaf(
        "doctor",
        "Check a PermDock installation and print a fix for each finding",
        {
          examples: [
            "permdock doctor",
            "permdock doctor --only imports,references",
            "permdock doctor --format github",
          ],
          docs: "doctor",
          effects: ["files"],
          config: true,
          findings: true,
          load: async () => (await import("../commands/doctor.ts")).doctor,
        },
      ),
      leaf(
        "completion",
        "Print the shell completion script for bash, zsh or fish",
        {
          examples: [
            "permdock completion zsh > ~/.zfunc/_permdock",
            'eval "$(permdock completion bash)"',
          ],
          docs: "completion",
          effects: [],
          config: false,
          shellOutput: true,
          load: async () =>
            (await import("../commands/completion.ts")).completion,
        },
      ),
    ],
  },
  {
    title: "Permissions",
    entries: [
      leaf(
        "collect",
        "Scan the sources for definePermissions() and references; write the catalog and barrel",
        {
          examples: [
            "permdock collect",
            "permdock collect --check",
            "permdock collect --watch",
          ],
          docs: "collect",
          effects: ["files"],
          config: true,
          load: async () => (await import("../commands/collect.ts")).collect,
        },
      ),
      leaf(
        "catalog",
        "Export the catalog as catalog JSON, JSON Schema or Markdown",
        {
          examples: [
            "permdock catalog --out permissions.catalog.json",
            "permdock catalog --kind markdown",
          ],
          docs: "catalog",
          effects: ["files"],
          config: true,
          load: async () => (await import("../commands/catalog.ts")).catalog,
        },
      ),
      leaf(
        "usage",
        "Report unused, ungranted and role-less permissions and conditions on undeclared fields",
        {
          examples: ["permdock usage", "permdock usage --fail-on warning"],
          docs: "usage",
          effects: [],
          config: true,
          findings: true,
          load: async () => (await import("../commands/usage.ts")).usage,
        },
      ),
      leaf(
        "diff",
        "Compare two policies or catalogs; exit 1 on a breaking change",
        {
          examples: [
            "permdock diff main.catalog.json permissions.catalog.json",
            "permdock diff ./old-policy.ts ./src/policy.ts --impact",
          ],
          docs: "diff",
          effects: [],
          config: true,
          load: async () => (await import("../commands/diff.ts")).diff,
        },
      ),
      leaf(
        "config",
        "Check permdock.config.ts for unknown keys, or print the effective config",
        {
          examples: ["permdock config", "permdock config --print"],
          docs: "config",
          effects: [],
          config: true,
          findings: true,
          load: async () => (await import("../commands/config.ts")).config,
        },
      ),
    ],
  },
  {
    title: "Database",
    entries: [
      group(
        "rls",
        "Generate, import, verify or migrate Postgres RLS policies",
        "rls",
        [
          leaf("generate", "Compile the policy into RLS policies and helpers", {
            examples: [
              "permdock rls generate --target sql --out supabase/schemas/permdock.sql",
              "permdock rls generate --check",
            ],
            docs: "rls",
            effects: ["files", "database:read", "network"],
            config: true,
            load: async () => (await import("../commands/rls.ts")).generate,
          }),
          leaf(
            "import",
            "Turn existing RLS policies into a generated definition",
            {
              examples: [
                "permdock rls import --sql schema.sql --out src/permissions.generated.ts",
                "permdock rls import --db-url-stdin --out src/permissions.generated.ts",
              ],
              docs: "rls",
              effects: ["files", "database:read"],
              config: true,
              load: async () =>
                (await import("../commands/rls.ts")).importPolicies,
            },
          ),
          leaf(
            "verify",
            "Run the fixtures against the policies, or compare a live database",
            {
              examples: [
                "permdock rls verify",
                "permdock rls verify --kind pgtap",
                "permdock rls verify --introspect --db-url-stdin",
              ],
              docs: "rls",
              effects: ["files", "database:read"],
              config: true,
              findings: true,
              load: async () => (await import("../commands/rls.ts")).verify,
            },
          ),
          leaf(
            "migrate",
            "Rewrite hand-written policies onto the generated helpers",
            {
              examples: [
                "permdock rls migrate --sql supabase/migrations --dry-run",
                "permdock rls migrate --sql supabase/migrations",
              ],
              docs: "rls",
              effects: ["rewrite", "files"],
              config: true,
              load: async () => (await import("../commands/rls.ts")).migrate,
            },
          ),
          leaf(
            "explain",
            "Show the tables, membership sources and triggers the SQL binds to",
            {
              examples: [
                "permdock rls explain",
                "permdock rls explain --db-url-stdin --json",
              ],
              docs: "rls",
              effects: ["database:read"],
              config: true,
              load: async () => (await import("../commands/rls.ts")).explain,
            },
          ),
        ],
      ),
      group(
        "supabase",
        "Generate the Supabase Custom Access Token Hook, or inspect its manifest",
        "supabase",
        [
          group("hook", "The Custom Access Token Hook", "supabase", [
            leaf(
              "generate",
              "Compile the membership sources into the hook migration",
              {
                examples: [
                  "permdock supabase hook generate --out supabase/schemas/permdock_hook.sql",
                  "permdock supabase hook generate --check",
                ],
                docs: "supabase",
                effects: ["files", "database:read"],
                config: true,
                load: async () =>
                  (await import("../commands/supabase.ts")).hookGenerate,
              },
            ),
          ]),
          leaf("inspect", "Print or write the hook and helper manifest", {
            examples: [
              "permdock supabase inspect",
              "permdock supabase inspect --out",
            ],
            docs: "supabase",
            effects: ["files"],
            config: true,
            load: async () => (await import("../commands/supabase.ts")).inspect,
          }),
        ],
      ),
      group(
        "powersync",
        "Generate PowerSync Sync Streams from the policy, or verify them",
        "powersync",
        [
          leaf("generate", "Compile the read grants into sync-config.yaml", {
            examples: [
              "permdock powersync generate",
              "permdock powersync generate --check",
            ],
            docs: "powersync",
            effects: ["files"],
            config: true,
            load: async () =>
              (await import("../commands/powersync.ts")).generate,
          }),
          leaf(
            "verify",
            "Fail on stale streams or a stream that syncs a denied row",
            {
              examples: [
                "permdock powersync verify",
                "permdock powersync verify --db-url-stdin",
              ],
              docs: "powersync",
              effects: ["database:read"],
              config: true,
              load: async () =>
                (await import("../commands/powersync.ts")).verify,
            },
          ),
        ],
      ),
      group(
        "scim",
        "Generate the Postgres tables postgresDirectoryStore keeps a SCIM directory in",
        "scim",
        [
          leaf(
            "generate",
            "Write the tenant-keyed users, groups and members tables",
            {
              examples: [
                "permdock scim generate",
                "permdock scim generate --dialect guc --out db/scim.sql",
                "permdock scim generate --check",
              ],
              docs: "scim",
              effects: ["files"],
              config: true,
              load: async () => (await import("../commands/scim.ts")).generate,
            },
          ),
        ],
      ),
    ],
  },
  {
    title: "Interop",
    entries: [
      group(
        "openapi",
        "Emit security into an OpenAPI document, or import one into a definition",
        "openapi",
        [
          leaf(
            "emit",
            "Write security and securitySchemes into an OpenAPI document",
            {
              examples: [
                "permdock openapi emit --doc openapi.json --out openapi.secured.json",
                "permdock openapi emit --doc openapi.json --kind overlay --out overlay.json",
              ],
              docs: "openapi",
              effects: ["files"],
              config: true,
              load: async () => (await import("../commands/openapi.ts")).emit,
            },
          ),
          leaf(
            "import",
            "Turn an OpenAPI document into a generated definition",
            {
              examples: [
                "permdock openapi import --doc openapi.yaml --out src/permissions.generated.ts",
              ],
              docs: "openapi",
              effects: ["files", "network"],
              config: false,
              load: async () =>
                (await import("../commands/openapi.ts")).importDocument,
            },
          ),
        ],
      ),
      group(
        "arazzo",
        "Check Arazzo workflows against the permissions",
        "arazzo",
        [
          leaf("check", "Resolve every Arazzo step to x-permdock-permissions", {
            examples: [
              "permdock arazzo check --doc arazzo.json --openapi openapi.json",
            ],
            docs: "arazzo",
            effects: [],
            config: true,
            findings: true,
            load: async () => (await import("../commands/arazzo.ts")).check,
          }),
        ],
      ),
      leaf(
        "scan",
        "List authorization checks written without PermDock, to adopt it in an existing app",
        {
          examples: [
            "permdock scan",
            "permdock scan --src app,lib --pattern isBeta",
          ],
          docs: "scan",
          effects: [],
          config: true,
          findings: true,
          load: async () => (await import("../commands/scan.ts")).scan,
        },
      ),
      group("casl", "Import CASL rules into a generated module", "casl", [
        leaf(
          "import",
          "Turn CASL rules per role into a permissions and policy module",
          {
            examples: [
              "permdock casl import --rules rules.json --out src/permissions.generated.ts",
            ],
            docs: "casl",
            effects: ["files"],
            config: false,
            load: async () => (await import("../commands/casl.ts")).caslImport,
          },
        ),
      ]),
      group(
        "casbin",
        "Import a Casbin model and policy into a generated module",
        "casbin",
        [
          leaf(
            "import",
            "Turn a Casbin RBAC model and policy into a permissions and policy module",
            {
              examples: [
                "permdock casbin import --model model.conf --policy policy.csv --out src/permissions.generated.ts",
              ],
              docs: "casbin",
              effects: ["files"],
              config: false,
              load: async () =>
                (await import("../commands/casbin.ts")).casbinImport,
            },
          ),
        ],
      ),
    ],
  },
  {
    title: "Account and Cloud",
    entries: [
      leaf(
        "login",
        "Log in to PermDock Cloud with the device flow (RFC 8628) or a loopback redirect (RFC 8252)",
        {
          examples: ["permdock login", "permdock login --scope catalog:write"],
          docs: "login",
          effects: ["network", "files"],
          config: false,
          load: async () => (await import("../commands/login.ts")).login,
        },
      ),
      leaf("logout", "Revoke and delete the stored PermDock Cloud login", {
        examples: ["permdock logout"],
        docs: "login",
        effects: ["network", "files"],
        config: false,
        load: async () => (await import("../commands/login.ts")).logout,
      }),
      leaf("whoami", "Print the PermDock Cloud identity the CLI acts as", {
        examples: ["permdock whoami", "permdock whoami --json"],
        docs: "login",
        effects: [],
        config: false,
        load: async () => (await import("../commands/login.ts")).whoami,
      }),
      group(
        "cloud",
        "Publish to or pull from a PermDock Cloud project",
        "cloud",
        [
          leaf(
            "push",
            "Publish the catalog, policy and manifest to a Cloud project",
            {
              examples: [
                "permdock cloud push --dry-run",
                "permdock cloud push --project prj_123",
              ],
              docs: "cloud",
              effects: ["network", "cloud:write"],
              config: true,
              load: async () => (await import("../commands/cloud.ts")).push,
            },
          ),
          leaf(
            "pull",
            "Write a Cloud project's published catalog and manifest",
            {
              examples: ["permdock cloud pull --project prj_123"],
              docs: "cloud",
              effects: ["network", "files"],
              config: true,
              load: async () => (await import("../commands/cloud.ts")).pull,
            },
          ),
        ],
      ),
    ],
  },
  {
    title: "Upgrade",
    entries: [
      leaf(
        "codemod",
        "Apply a release's renames to files that import permdock; list call sites to edit by hand",
        {
          examples: [
            "permdock codemod 0.5 --dry-run",
            "permdock codemod 0.5 src",
          ],
          docs: "codemod",
          effects: ["rewrite"],
          config: false,
          load: async () => (await import("../commands/codemod.ts")).codemod,
        },
      ),
    ],
  },
];

/** The hidden leaf shells call for dynamic completion candidates. */
const COMPLETE_LEAF: LeafEntry = leaf(
  "__complete",
  "Print completion candidates for a partial command line",
  {
    examples: [],
    docs: "completion",
    effects: [],
    config: false,
    shellOutput: true,
    hidden: true,
    load: async () => (await import("../commands/completion.ts")).complete,
  },
);

/** Names a future command takes; no command, group or alias may use them. */
export const RESERVED_NAMES: readonly string[] = ["link", "projects", "deploy"];

export const ROOT: GroupEntry = group(
  "permdock",
  "Collect, export, diff and check the permissions a PermDock policy declares",
  "",
  [...SECTIONS.flatMap((section) => section.entries), COMPLETE_LEAF],
);

/** Each leaf with its path from the root, in manifest order. */
export function leaves(
  entry: GroupEntry = ROOT,
  path: readonly string[] = [],
): readonly { readonly path: readonly string[]; readonly entry: LeafEntry }[] {
  return entry.children.flatMap((child) =>
    child.kind === "leaf"
      ? [{ path: [...path, child.name], entry: child }]
      : leaves(child, [...path, child.name]),
  );
}

export type Resolved =
  | {
      readonly kind: "leaf";
      readonly path: readonly string[];
      readonly entry: LeafEntry;
      readonly rest: readonly string[];
    }
  | {
      readonly kind: "group";
      readonly path: readonly string[];
      readonly entry: GroupEntry;
      /** The token that named no child, when there was one. */
      readonly unknown?: string;
      readonly rest: readonly string[];
    };

/**
 * Walks positional tokens down the tree until a leaf. Flags may sit
 * anywhere; only bare words name a child.
 */
export function resolve(argv: readonly string[]): Resolved {
  let node: GroupEntry = ROOT;
  const path: string[] = [];
  const rest: string[] = [];
  for (const [i, token] of argv.entries()) {
    if (token === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      rest.push(token);
      continue;
    }
    const child = node.children.find((item) => item.name === token);
    if (child === undefined) {
      return {
        kind: "group",
        path,
        entry: node,
        unknown: token,
        rest: [...rest, ...argv.slice(i + 1)],
      };
    }
    path.push(child.name);
    if (child.kind === "leaf") {
      return {
        kind: "leaf",
        path,
        entry: child,
        rest: [...rest, ...argv.slice(i + 1)],
      };
    }
    node = child;
  }
  return { kind: "group", path, entry: node, rest };
}
