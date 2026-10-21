import type { Leaf } from "../core/command.ts";
import type { CliContext } from "../core/context.ts";
import type { Env } from "../core/env.ts";

import { defineLeaf } from "../core/command.ts";
import { secretInput } from "../core/credentials.ts";
import { dryRunFlag, given } from "../core/flags.ts";

const sharedFlags = {
  url: { type: "string", description: "Cloud API base URL", valueHint: "url" },
  manifest: {
    type: "string",
    description:
      "Manifest file to send or write (default permdock.manifest.json)",
    valueHint: "file",
  },
} as const;

/** `env` with the stdin secret in place of the variable it stands for. */
async function withStdinSecret(
  ctx: CliContext,
  flag: string,
  stdin: boolean,
  variable: string,
): Promise<Env> {
  const value = await secretInput(ctx, { flag, stdin });
  return value === undefined ? ctx.env : { ...ctx.env, [variable]: value };
}

export const push: Leaf = defineLeaf({
  flags: {
    ...sharedFlags,
    project: {
      type: "string",
      description:
        "Cloud project id (default PERMDOCK_CLOUD_ENV, then the key's environment)",
      valueHint: "id",
    },
    ...dryRunFlag,
    "key-stdin": {
      type: "boolean",
      description: "Read PERMDOCK_CLOUD_KEY from stdin",
    },
  },
  async run(ctx, { flags }) {
    const env = await withStdinSecret(
      ctx,
      "key",
      flags["key-stdin"],
      "PERMDOCK_CLOUD_KEY",
    );
    // Lazy: the implementation loads only when this command runs, not for --help.
    return (await import("../cloud/push.ts")).runCloud({
      cwd: ctx.cwd,
      config: ctx.config,
      url: given(flags.url),
      project: given(flags.project),
      manifest: given(flags.manifest),
      dryRun: flags["dry-run"],
      json: ctx.json,
      env,
      now: ctx.now,
      io: ctx.io,
    });
  },
});

export const pull: Leaf = defineLeaf({
  flags: {
    ...sharedFlags,
    project: {
      type: "string",
      description:
        "Cloud project id (default the one project PERMDOCK_CLOUD_TOKEN names)",
      valueHint: "id",
    },
    "token-stdin": {
      type: "boolean",
      description: "Read PERMDOCK_CLOUD_TOKEN from stdin",
    },
  },
  async run(ctx, { flags }) {
    const env = await withStdinSecret(
      ctx,
      "token",
      flags["token-stdin"],
      "PERMDOCK_CLOUD_TOKEN",
    );
    // Lazy: the implementation loads only when this command runs, not for --help.
    return (await import("../cloud/pull.ts")).runCloudPull({
      cwd: ctx.cwd,
      config: ctx.config,
      url: given(flags.url),
      project: given(flags.project),
      manifest: given(flags.manifest),
      json: ctx.json,
      env,
      io: ctx.io,
    });
  },
});
