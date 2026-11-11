import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { CliError } from "../core/errors.ts";
import {
  checkFlag,
  dbUrl,
  dbUrlFlags,
  dryRunFlag,
  generateFlags,
  policyFlag,
} from "../core/flags.ts";
import { executeGenerate } from "../generate/execute.ts";
import { receiptRows } from "../generate/pipeline.ts";

function concurrencyFlag(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError("usage", "--concurrency must be a positive integer", {
      code: "invalid_value",
    });
  }
  return parsed;
}

export const generate: Leaf = defineLeaf({
  flags: {
    ...checkFlag,
    ...dryRunFlag,
    ...policyFlag,
    ...dbUrlFlags,
    ...generateFlags,
  },
  async run(ctx, { flags }) {
    if (flags.watch && (flags.check || flags["dry-run"])) {
      throw new CliError(
        "usage",
        "generate: --watch writes files; drop --check and --dry-run",
        { code: "invalid_value" },
      );
    }
    const concurrency = concurrencyFlag(flags.concurrency);
    const db = await dbUrl(ctx, flags);
    const policy =
      flags.policy !== undefined && flags.policy !== ""
        ? flags.policy
        : ctx.config.policy;
    if (flags.watch) {
      // Lazy: the watcher and its worker load only for --watch, not for --help.
      const { watchGenerate } = await import("../generate/watch.ts");
      return watchGenerate(ctx, {
        ...(policy === undefined ? {} : { policy }),
        only: flags.only,
        noCache: flags["no-cache"],
        ...(flags["cache-dir"] === undefined || flags["cache-dir"] === ""
          ? {}
          : { cacheDir: flags["cache-dir"] }),
        ...(concurrency === undefined ? {} : { concurrency }),
      });
    }
    const phase = ctx.progress("Generating");
    try {
      const executed = await executeGenerate({
        cwd: ctx.cwd,
        config: ctx.config,
        policyPath: policy,
        only: flags.only,
        check: flags.check,
        dryRun: flags["dry-run"],
        noCache: flags["no-cache"],
        ...(flags["cache-dir"] === undefined || flags["cache-dir"] === ""
          ? {}
          : { cacheDir: flags["cache-dir"] }),
        ...(concurrency === undefined ? {} : { concurrency }),
        ...(db === undefined ? {} : { db }),
      });
      const wrote = executed.summary.created + executed.summary.updated;
      phase.done(`Generated ${wrote} ${wrote === 1 ? "file" : "files"}`);
      for (const row of receiptRows(executed.summary)) {
        ctx.io.stderr(`${row}\n`);
      }
      return {
        code: executed.code,
        output: executed.output,
        data: { files: executed.run.files, summary: executed.summary },
      };
    } catch (error) {
      phase.done();
      throw error;
    }
  },
});
