import type { EmittedFile, EmitSource, PluginTask } from "../plugin.ts";
import type { OpenApiPluginOptions } from "./openapi.ts";

import { CliError } from "../../core/errors.ts";

/** The annotated document, without writing it. */
export async function openapiDocument(
  task: PluginTask,
  options: OpenApiPluginOptions,
  source: EmitSource,
): Promise<readonly EmittedFile[]> {
  if (options.doc === undefined) {
    return [];
  }
  // Lazy: the OpenAPI writer loads only when a document is emitted.
  const { runOpenapi } = await import("../../openapi/openapi.ts");
  const outcome = await runOpenapi({
    cwd: source.cwd,
    config: source.config,
    rest: ["emit"],
    doc: options.doc,
    out: task.out,
    from: undefined,
    target: "3.1",
    format: "document",
    overlay: "1.1",
    check: false,
    profile: undefined,
    profileScheme: undefined,
    scheme: "oauth",
    metadataUrl: undefined,
    deviceFlow: false,
    preview: true,
    io: {
      stdout() {
        return undefined;
      },
      stderr() {
        return undefined;
      },
    },
  });
  if (outcome.code !== 0) {
    throw new CliError(
      outcome.code === 2 ? "usage" : "failed",
      outcome.output,
      { code: outcome.code === 2 ? "config_invalid" : "check_failed" },
    );
  }
  return [{ path: task.out, contents: outcome.output }];
}
