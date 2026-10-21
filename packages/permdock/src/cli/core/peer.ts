import type { Agent } from "package-manager-detector";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { detect, getUserAgent, resolveCommand } from "package-manager-detector";

import { CliError } from "./errors.ts";

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
  minimumMajor?: number,
): Promise<T> {
  try {
    const loaded = await load();
    const found = installedMajor(name);
    if (minimumMajor !== undefined && found < minimumMajor) {
      const agent = await packageManagerOf(cwd);
      throw new CliError(
        "unavailable",
        `PermDock CLI: ${command} needs ${name} ${String(minimumMajor)} or later; ${String(found)} is installed. Upgrade it with: ${addLine(agent, [`${name}@latest`], { dev: true })}`,
        {
          code: "dependency_missing",
          extensions: { package: name, minimum: minimumMajor, found },
          next: [
            {
              command: addLine(agent, [`${name}@latest`], { dev: true }),
              when: "to upgrade it",
            },
          ],
        },
      );
    }
    return loaded;
  } catch (error) {
    if (!isMissingModule(error)) {
      throw error;
    }
    const agent = await packageManagerOf(cwd);
    throw new CliError("unavailable", peerHint(name, command, agent), {
      cause: error,
      code: "dependency_missing",
      extensions: { package: name },
      next: [
        {
          command: addLine(agent, [name], { dev: true }),
          when: "to install it",
        },
      ],
    });
  }
}

/**
 * The major version of the installed `name`; `NaN` when its package.json cannot
 * be read, which no minimum rejects.
 */
function installedMajor(name: string): number {
  try {
    const file = createRequire(import.meta.url).resolve(`${name}/package.json`);
    const manifest: { readonly version?: unknown } = JSON.parse(
      readFileSync(file, "utf8"),
    );
    return Math.trunc(Number(String(manifest.version).split(".")[0]));
  } catch {
    return Number.NaN;
  }
}

/**
 * The package manager whose lockfile the project has, else the one running the
 * CLI.
 */
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
