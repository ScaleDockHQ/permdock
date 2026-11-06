import { resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { isRecord } from "../../core/compact.ts";
import { describeError } from "../core/errors.ts";
import { readConfig } from "../project/config.ts";
import { executeGenerate } from "./execute.ts";

type WatchRequest = {
  readonly cwd: string;
  readonly configFile?: string;
  readonly policy?: string;
  readonly only: readonly string[];
  readonly noCache: boolean;
  readonly cacheDir?: string;
  readonly concurrency?: number;
};

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

function requestOf(value: unknown): WatchRequest {
  if (!isRecord(value) || typeof value["cwd"] !== "string") {
    throw new Error("generate worker received no request");
  }
  const only = stringList(value["only"]);
  if (only === undefined) {
    throw new Error("generate worker received no request");
  }
  const concurrency = value["concurrency"];
  return {
    cwd: value["cwd"],
    ...(typeof value["configFile"] === "string"
      ? { configFile: value["configFile"] }
      : {}),
    ...(typeof value["policy"] === "string" ? { policy: value["policy"] } : {}),
    only,
    noCache: value["noCache"] === true,
    ...(typeof value["cacheDir"] === "string"
      ? { cacheDir: value["cacheDir"] }
      : {}),
    ...(typeof concurrency === "number" ? { concurrency } : {}),
  };
}

/**
 * One generate in a fresh thread. The thread is terminated after it replies, so
 * the next edit loads the policy again: native ESM cannot be unloaded.
 */
async function main(): Promise<void> {
  const request = requestOf(workerData);
  const loaded = await readConfig(request.cwd, request.configFile, {
    fresh: true,
  });
  const executed = await executeGenerate({
    cwd: request.cwd,
    config: loaded.config,
    policyPath:
      request.policy !== undefined && request.policy !== ""
        ? request.policy
        : loaded.config.policy,
    only: request.only,
    check: false,
    dryRun: false,
    noCache: request.noCache,
    ...(request.cacheDir === undefined ? {} : { cacheDir: request.cacheDir }),
    ...(request.concurrency === undefined
      ? {}
      : { concurrency: request.concurrency }),
  });
  const configPath =
    loaded.file === undefined ? [] : [resolve(request.cwd, loaded.file)];
  const reply = {
    ok: true,
    summary: executed.summary,
    written: executed.written,
    inputs: [...executed.inputs, ...configPath],
  };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port has no origin; the transfer list is the second argument
  parentPort?.postMessage(reply);
}

try {
  await main();
} catch (error) {
  const failure = { ok: false, message: describeError(error) };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port has no origin; the transfer list is the second argument
  parentPort?.postMessage(failure);
}
