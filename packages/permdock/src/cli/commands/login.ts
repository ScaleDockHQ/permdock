import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

const urlArg = {
  type: "string",
  description:
    "Issuer URL (default PERMDOCK_CLOUD_URL, then https://permdock.com/api)",
  valueHint: "url",
} as const;

export function login(ctx: CliContext): Command {
  return defineCommand({
    meta: { name: "login", description: COMMAND_DESCRIPTIONS.login },
    args: {
      ...globalArgs,
      url: urlArg,
      loopback: {
        type: "boolean",
        description:
          "Use a 127.0.0.1 redirect with PKCE instead of the device flow",
      },
      write: {
        type: "boolean",
        description: "Also request catalog:write, for permdock cloud push",
      },
      open: {
        type: "boolean",
        description: "Open the browser at the verification URL",
        default: true,
        negativeDescription: "Print the URL only",
      },
    },
    async run({ args: parsed }) {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runLogin } = await import("../cloud/login.ts");
      ctx.report(
        await runLogin({
          cwd: ctx.cwd,
          url: stringArg(parsed.url),
          loopback: parsed.loopback === true,
          write: parsed.write === true,
          open: parsed.open !== false && ctx.interactive,
          json: ctx.json,
          env: ctx.io.env ?? process.env,
          io: ctx.io,
        }),
      );
    },
  });
}

export function logout(ctx: CliContext): Command {
  return defineCommand({
    meta: { name: "logout", description: COMMAND_DESCRIPTIONS.logout },
    args: { ...globalArgs, url: urlArg },
    async run({ args: parsed }) {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runLogout } = await import("../cloud/login.ts");
      ctx.report(
        await runLogout({
          url: stringArg(parsed.url),
          json: ctx.json,
          env: ctx.io.env ?? process.env,
          io: ctx.io,
        }),
      );
    },
  });
}
