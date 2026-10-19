import { type Leaf, defineLeaf } from "../core/command.ts";
import { missingInput } from "../core/errors.ts";
import {
  checkFlag,
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

export const emit: Leaf = defineLeaf({
  flags: {
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
  },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    return (await import("../openapi/openapi.ts")).runOpenapi({
      cwd: ctx.cwd,
      config: ctx.config,
      rest: ["emit"],
      doc: given(flags.doc),
      out: given(flags.out),
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
    const { runOpenapiImport } = await import("../openapi/import.ts");
    return runOpenapiImport({
      cwd: ctx.cwd,
      doc,
      out: given(flags.out),
      schema: flags.validator,
      map: given(flags.map),
      annotate: flags.annotate,
      io: ctx.io,
    });
  },
});
