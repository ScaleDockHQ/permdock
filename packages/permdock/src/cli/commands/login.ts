import { type Leaf, defineLeaf } from "../core/command.ts";
import { given } from "../core/flags.ts";

const urlFlag = {
  url: {
    type: "string",
    description:
      "Issuer URL (default PERMDOCK_CLOUD_URL, then https://permdock.com/api)",
    valueHint: "url",
  },
} as const;

export const login: Leaf = defineLeaf({
  flags: {
    ...urlFlag,
    loopback: {
      type: "boolean",
      description:
        "Use a 127.0.0.1 redirect with PKCE instead of the device flow",
    },
    scope: {
      type: "enum",
      options: ["catalog:write"],
      repeatable: true,
      description:
        "Scopes beyond projects:read and policy:read; catalog:write for permdock cloud push",
    },
    open: {
      type: "boolean",
      default: true,
      description: "Open the browser at the verification URL",
      negativeDescription: "Print the URL only",
    },
  },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runLogin } = await import("../cloud/login.ts");
    return runLogin({
      cwd: ctx.cwd,
      url: given(flags.url),
      loopback: flags.loopback,
      scopes: flags.scope,
      open: flags.open && ctx.interactive,
      json: ctx.json,
      env: ctx.env,
      io: ctx.io,
    });
  },
});

export const logout: Leaf = defineLeaf({
  flags: { ...urlFlag },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runLogout } = await import("../cloud/login.ts");
    return runLogout({
      url: given(flags.url),
      json: ctx.json,
      env: ctx.env,
      io: ctx.io,
    });
  },
});

export const whoami: Leaf = defineLeaf({
  flags: { ...urlFlag },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runWhoami } = await import("../cloud/login.ts");
    return runWhoami({
      url: given(flags.url),
      json: ctx.json,
      env: ctx.env,
      io: ctx.io,
    });
  },
});
