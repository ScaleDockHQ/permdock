import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { given, permissionsFlag } from "../core/flags.ts";

export const check: Leaf = defineLeaf({
  flags: {
    doc: {
      type: "string",
      description: "Arazzo document",
      valueHint: "arazzo.json",
    },
    openapi: {
      type: "string",
      description: "OpenAPI document the workflows call",
      valueHint: "doc.json",
    },
    workflow: {
      type: "string",
      description: "Check one workflow",
      valueHint: "id",
    },
    ...permissionsFlag,
  },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    return (await import("../arazzo.ts")).runArazzo({
      cwd: ctx.cwd,
      config: ctx.config,
      doc: given(flags.doc),
      openapi: given(flags.openapi),
      workflow: given(flags.workflow),
      from: given(flags.permissions),
      json: ctx.json,
    });
  },
});
