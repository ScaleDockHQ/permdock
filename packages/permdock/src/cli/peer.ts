import {
  type Agent,
  detect,
  getUserAgent,
  resolveCommand,
} from "package-manager-detector";

/**
 * Loads an optional peer dependency for one command, or fails with the line
 * that installs it with the project's package manager. Only the commands that
 * need a peer ever load it.
 */
export async function requirePeer<T>(
  load: () => Promise<T>,
  name: string,
  command: string,
  cwd: string = process.cwd(),
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!isMissingModule(error)) {
      throw error;
    }
    throw new Error(peerHint(name, command, await packageManagerOf(cwd)), {
      cause: error,
    });
  }
}

/** The package manager whose lockfile the project has, else the one running the CLI. */
export async function packageManagerOf(
  cwd: string,
): Promise<Agent | undefined> {
  return (await detect({ cwd }))?.agent ?? getUserAgent() ?? undefined;
}

/** The command that adds `packages` with `agent`, npm when there is none. */
export function addLine(
  agent: Agent | undefined,
  packages: readonly string[],
  options?: { readonly dev?: boolean },
): string {
  const args = options?.dev === true ? ["-D", ...packages] : [...packages];
  const command = resolveCommand(agent ?? "npm", "add", args);
  return command === null
    ? `npm install ${args.join(" ")}`
    : [command.command, ...command.args].join(" ");
}

function isMissingModule(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND"
  );
}

/**
 * The error for a missing peer. `agent` is the package manager that ran the
 * command, or the one whose lockfile the project has; without one the line
 * names pnpm and npm.
 */
export function peerHint(
  name: string,
  command: string,
  agent: Agent | undefined = getUserAgent() ?? undefined,
): string {
  const install =
    agent === undefined
      ? undefined
      : resolveCommand(agent, "add", ["-D", name]);
  const line =
    install === null || install === undefined
      ? `pnpm add -D ${name} (or npm install -D ${name})`
      : [install.command, ...install.args].join(" ");
  return `PermDock CLI: ${command} needs the optional peer ${name}. Install it with: ${line}`;
}
