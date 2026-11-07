import type { FlagValues } from "../core/command.ts";
import type { Leaf } from "../core/command.ts";
import type { CliContext } from "../core/context.ts";
import type { CommandResult } from "../core/result.ts";

import { parseLeaf } from "../core/args.ts";
import { defineLeaf } from "../core/command.ts";
import { missingInput } from "../core/errors.ts";
import {
  checkFlag,
  fileOut,
  given,
  outFlag,
  policyFlag,
  validatorFlag,
} from "../core/flags.ts";

const docFlag = {
  doc: {
    type: "string",
    description: "OpenAPI document: a path, or a URL for import",
    valueHint: "path",
  },
} as const;

const emitFlags = {
  ...docFlag,
  ...outFlag,
  ...checkFlag,
  ...policyFlag,
  target: {
    type: "enum",
    options: ["3.1", "3.2", "3.3"],
    default: "3.2",
    description: "OpenAPI version; 3.3 is the pinned Security Profiles draft",
  },
  kind: {
    type: "enum",
    options: ["document", "overlay"],
    default: "document",
    description: "A full document or an Overlay",
  },
  overlay: {
    type: "enum",
    options: ["1.1", "1.2"],
    default: "1.1",
    description: "Overlay version; 1.2 is the pinned reusable-actions draft",
  },
  profile: {
    type: "enum",
    options: ["fapi2"],
    description: "Security profile to declare",
  },
  "profile-scheme": {
    type: "string",
    description: "Security scheme name for the profile",
    valueHint: "name",
  },
  scheme: {
    type: "string",
    description: "OAuth security scheme name (default permdockOAuth)",
    valueHint: "name",
  },
  "metadata-url": {
    type: "string",
    description: "OAuth authorization server metadata URL",
    valueHint: "url",
  },
  "device-flow": {
    type: "boolean",
    description: "Declare the device authorization flow",
  },
  arity: {
    type: "boolean",
    description: "Mark instance and collection operations",
  },
  "authorization-url": {
    type: "string",
    description: "OAuth authorization endpoint",
    valueHint: "url",
  },
  "token-url": {
    type: "string",
    description: "OAuth token endpoint",
    valueHint: "url",
  },
  "device-authorization-url": {
    type: "string",
    description: "OAuth device authorization endpoint",
    valueHint: "url",
  },
} as const;

export function openapiEmitFromFlags(
  ctx: CliContext,
  argv: readonly string[],
): Promise<CommandResult> {
  const parsed = parseLeaf("openapi emit", argv, emitFlags);
  // SAFETY: parseLeaf widens the flag object to Flags; the values are this command's.
  return executeOpenapiEmit(ctx, parsed.flags as FlagValues<typeof emitFlags>);
}

async function executeOpenapiEmit(
  ctx: CliContext,
  flags: FlagValues<typeof emitFlags>,
): Promise<CommandResult> {
  // Lazy: the implementation loads only when this command runs, not for --help.
  return (await import("../openapi/openapi.ts")).runOpenapi({
    cwd: ctx.cwd,
    config: ctx.config,
    rest: ["emit"],
    doc: given(flags.doc),
    out: fileOut("openapi emit", flags.out),
    from: given(flags.policy),
    target: flags.target,
    format: flags.kind,
    overlay: flags.overlay,
    check: flags.check,
    profile: flags.profile,
    profileScheme: given(flags["profile-scheme"]),
    scheme: given(flags.scheme) ?? "permdockOAuth",
    metadataUrl: given(flags["metadata-url"]),
    deviceFlow: flags["device-flow"],
    arity: flags.arity,
    authorizationUrl: given(flags["authorization-url"]),
    tokenUrl: given(flags["token-url"]),
    deviceAuthorizationUrl: given(flags["device-authorization-url"]),
    io: ctx.io,
  });
}

const annotateFlags = {
  routes: {
    type: "string",
    description: "Glob of route modules with @permission comments",
    valueHint: "glob",
  },
  ...outFlag,
} as const;

async function executeAnnotate(
  ctx: CliContext,
  flags: FlagValues<typeof annotateFlags>,
): Promise<CommandResult> {
  const routes = given(flags.routes);
  if (routes === undefined) {
    throw missingInput(
      "openapi annotate",
      ["--routes"],
      "the route modules to read",
    );
  }
  return (await import("../openapi/annotate.ts")).runAnnotate({
    cwd: ctx.cwd,
    routes,
    out:
      fileOut("openapi annotate", flags.out) ?? "src/operations.generated.ts",
    io: ctx.io,
  });
}

export const annotateRoutes: Leaf = defineLeaf({
  flags: annotateFlags,
  run(ctx, { flags }) {
    return executeAnnotate(ctx, flags);
  },
});

export const importDocument: Leaf = defineLeaf({
  flags: {
    ...docFlag,
    ...outFlag,
    ...validatorFlag,
    map: {
      type: "string",
      description: "JSON mapping of operations to permissions",
      valueHint: "json",
    },
    annotate: {
      type: "boolean",
      description: "Write x-permdock-permissions back into the document",
    },
  },
  async run(ctx, { flags }) {
    const doc = given(flags.doc);
    if (doc === undefined) {
      throw missingInput(
        "openapi import",
        ["--doc"],
        "the OpenAPI document to import",
      );
    }
    // Lazy: the implementation loads only when this command runs, not for --help.
    return (await import("../openapi/import.ts")).runOpenapiImport({
      cwd: ctx.cwd,
      doc,
      out: fileOut("openapi import", flags.out),
      schema: flags.validator,
      map: given(flags.map),
      annotate: flags.annotate,
      io: ctx.io,
    });
  },
});
