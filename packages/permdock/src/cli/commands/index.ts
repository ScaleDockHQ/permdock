import type { CliContext, Command } from "./context.ts";

type CommandFactory = (ctx: CliContext) => Command;

export type CommandName =
  | "collect"
  | "catalog"
  | "diff"
  | "usage"
  | "doctor"
  | "config"
  | "skills"
  | "openapi"
  | "rls"
  | "arazzo"
  | "cloud"
  | "supabase"
  | "powersync";

/** What `permdock --help` lists, without loading any command module. */
export const COMMAND_DESCRIPTIONS: Readonly<Record<CommandName, string>> = {
  collect:
    "Scan the sources for definePermissions() and permission references; write the catalog and barrel",
  catalog: "Export the catalog as JSON, JSON Schema or Markdown",
  diff: "Compare two policies or catalogs; exit 1 on a breaking change",
  usage:
    "Report unused, ungranted and role-less permissions and conditions on undeclared fields",
  doctor: "Check a PermDock installation and print a fix for each finding",
  config:
    "Check permdock.config.ts for unknown keys, or print the effective config",
  skills: "Install, update or list the PermDock Agent Skills",
  openapi:
    "Emit security into an OpenAPI document, or import one into a generated definition",
  rls: "Generate, import, verify or migrate Postgres RLS policies from the policy",
  arazzo: "Resolve every Arazzo step to x-permdock-permissions",
  cloud:
    "Publish the catalog, hostable flags and role assignability to a PermDock Cloud environment",
  supabase:
    "Generate the Supabase Custom Access Token Hook, or inspect its manifest",
  powersync:
    "Generate PowerSync Sync Streams from the policy, or verify them against the fixtures",
};

/** Every top-level command, loaded only when it runs or its own `--help` is asked for. */
export const commands: Readonly<
  Record<CommandName, () => Promise<CommandFactory>>
> = {
  collect: async () => (await import("./collect.ts")).collect,
  catalog: async () => (await import("./catalog.ts")).catalog,
  diff: async () => (await import("./diff.ts")).diff,
  usage: async () => (await import("./usage.ts")).usage,
  doctor: async () => (await import("./doctor.ts")).doctor,
  config: async () => (await import("./config.ts")).config,
  skills: async () => (await import("./skills.ts")).skills,
  openapi: async () => (await import("./openapi.ts")).openapi,
  rls: async () => (await import("./rls.ts")).rls,
  arazzo: async () => (await import("./arazzo.ts")).arazzo,
  cloud: async () => (await import("./cloud.ts")).cloud,
  supabase: async () => (await import("./supabase.ts")).supabase,
  powersync: async () => (await import("./powersync.ts")).powersync,
};

export function isCommand(name: string): name is CommandName {
  return Object.hasOwn(commands, name);
}
