import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CommandResult } from "../core/result.ts";
import type { EmittedFile } from "../generate/plugin.ts";
import type { CliIo } from "../types.ts";

import {
  operationsModule,
  routesFromSource,
} from "../../openapi/annotate-routes.ts";
import { rel } from "../files.ts";

export function operationsFile(
  cwd: string,
  routes: string,
  out: string,
): readonly EmittedFile[] {
  const files = globSync(routes, { cwd }).toSorted();
  const found = files.flatMap((file) =>
    routesFromSource(file, readFileSync(resolve(cwd, file), "utf8")),
  );
  return [{ path: out, contents: operationsModule(found) }];
}

export function runAnnotate(input: {
  readonly cwd: string;
  readonly routes: string;
  readonly out: string;
  readonly io: CliIo;
}): CommandResult {
  const [file] = operationsFile(input.cwd, input.routes, input.out);
  const routes = file?.contents.match(/":/gu)?.length ?? 0;
  const contents = file?.contents ?? "";
  const out = resolve(input.cwd, input.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, contents);
  return {
    code: 0,
    output: `wrote ${rel(input.cwd, out)} (${String(routes)} operations)\n`,
  };
}
