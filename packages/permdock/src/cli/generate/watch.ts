import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { CliContext } from "../core/context.ts";
import type { CommandResult } from "../core/result.ts";
import type { GenerateSummary } from "./pipeline.ts";

import { isRecord } from "../../core/compact.ts";
import { dateAt } from "../../core/time.ts";
import { CliError, describeError } from "../core/errors.ts";
import { createChangeScheduler } from "../watch.ts";
import { receiptRows } from "./pipeline.ts";

export type GenerateWatchOptions = {
  readonly policy?: string;
  readonly only: readonly string[];
  readonly noCache: boolean;
  readonly cacheDir?: string;
  readonly concurrency?: number;
};

type WatchReply =
  | {
      readonly ok: true;
      readonly summary: GenerateSummary;
      readonly written: readonly string[];
      readonly inputs: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

function workerUrl(): URL {
  const source = new URL("./watch-worker.ts", import.meta.url);
  if (existsSync(fileURLToPath(source))) {
    return source;
  }
  const built = new URL("./watch-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(built))) {
    return built;
  }
  throw new CliError(
    "internal",
    "generate watch worker is missing from this build",
    { code: "internal" },
  );
}

function summaryOf(value: unknown): GenerateSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const created = value["created"];
  const updated = value["updated"];
  const unchanged = value["unchanged"];
  const planned = value["planned"];
  const skipped = value["skipped"];
  if (
    typeof created !== "number" ||
    typeof updated !== "number" ||
    typeof unchanged !== "number" ||
    typeof planned !== "number" ||
    typeof skipped !== "number"
  ) {
    return undefined;
  }
  return { created, updated, unchanged, planned, skipped };
}

/** The worker message as a reply. A shape the worker does not send is a failure. */
export function parseWatchReply(value: unknown): WatchReply {
  if (!isRecord(value)) {
    return { ok: false, message: "generate worker returned nothing" };
  }
  if (value["ok"] !== true) {
    return {
      ok: false,
      message:
        typeof value["message"] === "string"
          ? value["message"]
          : "generate worker failed",
    };
  }
  const summary = summaryOf(value["summary"]);
  const written = value["written"];
  const inputs = value["inputs"];
  if (
    summary === undefined ||
    !Array.isArray(written) ||
    !Array.isArray(inputs)
  ) {
    return { ok: false, message: "generate worker returned nothing" };
  }
  return {
    ok: true,
    summary,
    written: written.filter((item) => typeof item === "string"),
    inputs: inputs.filter((item) => typeof item === "string"),
  };
}

function runWorker(
  ctx: CliContext,
  options: GenerateWatchOptions,
): Promise<WatchReply> {
  const url = workerUrl();
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      workerData: {
        cwd: ctx.cwd,
        ...(ctx.configFile === undefined ? {} : { configFile: ctx.configFile }),
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        only: options.only,
        noCache: options.noCache,
        ...(options.cacheDir === undefined
          ? {}
          : { cacheDir: options.cacheDir }),
        ...(options.concurrency === undefined
          ? {}
          : { concurrency: options.concurrency }),
      },
      execArgv: url.pathname.endsWith(".ts")
        ? ["--experimental-strip-types"]
        : [],
    });
    let settled = false;
    const finish = (reply: WatchReply): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(reply);
      void worker.terminate();
    };
    worker.once("message", (message: unknown) => {
      finish(parseWatchReply(message));
    });
    worker.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      void worker.terminate();
      reject(error instanceof Error ? error : new Error(describeError(error)));
    });
  });
}

function receipt(ctx: CliContext, summary: GenerateSummary): void {
  if (ctx.json) {
    ctx.io.stdout(
      `${JSON.stringify({
        event: "generate",
        status: "success",
        summary,
        at: dateAt().toISOString(),
      })}\n`,
    );
    return;
  }
  const wrote = summary.created + summary.updated;
  const phase = ctx.progress("Generating");
  phase.done(`Generated ${wrote} ${wrote === 1 ? "file" : "files"}`);
  for (const row of receiptRows(summary)) {
    ctx.io.stderr(`${row}\n`);
  }
}

/**
 * `generate --watch`: one generate now, then one per change until Ctrl-C. Each
 * cycle loads the policy in a new worker. Under `--json` each cycle is one JSON
 * line on stdout.
 */
export async function watchGenerate(
  ctx: CliContext,
  options: GenerateWatchOptions,
): Promise<CommandResult> {
  const fail = (message: string): void => {
    if (ctx.json) {
      ctx.io.stdout(
        `${JSON.stringify({
          event: "generate",
          status: "error",
          message,
          at: dateAt().toISOString(),
        })}\n`,
      );
      return;
    }
    ctx.log(message);
  };
  const scheduler = createChangeScheduler({
    cwd: ctx.cwd,
    report: (message) => {
      if (message !== undefined) {
        fail(message);
      }
    },
    cycle: async () => {
      const reply = await runWorker(ctx, options);
      if (!reply.ok) {
        throw new Error(reply.message);
      }
      receipt(ctx, reply.summary);
      return {
        message: undefined,
        written: reply.written,
        sources: [],
        inputs: reply.inputs,
      };
    },
  });
  try {
    await scheduler.run();
  } catch (error) {
    fail(describeError(error));
  }
  scheduler.watch();
  ctx.signal.addEventListener("abort", () => {
    scheduler.close();
  });
  if (!ctx.json) {
    ctx.log("watching for changes; Ctrl-C to stop");
  }
  return { code: 0, output: "", streamed: true };
}
