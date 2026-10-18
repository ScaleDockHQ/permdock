import { existsSync, readFileSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { CatalogDocument } from "../../catalog/types.ts";
import type { CommandResult } from "../shared/result.ts";
import type { CliIo, PermDockConfig } from "../types.ts";

import { parseCatalog } from "../../catalog/parse.ts";
import { catalogFingerprint } from "../../core/catalog-fingerprint.ts";
import { parseSupabaseManifest } from "../../supabase/manifest.ts";
import { formatCatalogJson } from "../catalog-doc.ts";
import { catalogPath } from "../catalog-path.ts";
import { describeError } from "../errors.ts";
import { writeFileEnsuringDir } from "../files.ts";
import { formatManifestJson, MANIFEST_FILE } from "../manifest-json.ts";
import { cliVersion } from "../version.ts";
import { cliRuntime, readAuth } from "./auth.ts";
import { cloudUrl, type Env } from "./issuer.ts";
import {
  type CloudRequest,
  type ProjectPolicy,
  projectPolicy,
  resolveProject,
} from "./projects.ts";

const COMMAND = "permdock cloud pull";

/**
 * The project's pushed policy, read with `PERMDOCK_CLOUD_TOKEN` or the stored
 * login. Shared by `cloud pull` and `rls generate --project`.
 */
export async function fetchProjectPolicy(input: {
  readonly command: string;
  readonly url: string | undefined;
  readonly project: string | undefined;
  readonly json: boolean;
  readonly env: Env;
  readonly io: CliIo;
}): Promise<
  | { readonly ok: true; readonly value: ProjectPolicy }
  | { readonly ok: false; readonly result: CommandResult }
> {
  const issuer = cloudUrl(input.url, input.env);
  const auth = await readAuth(
    input.command,
    issuer,
    input.env,
    cliRuntime(input.io, input.env),
  );
  if (!auth.ok) {
    return { ok: false, result: { code: auth.code, output: auth.output } };
  }
  const request: CloudRequest = {
    issuer,
    bearer: auth.bearer,
    io: input.io,
    json: input.json,
    command: input.command,
  };
  const project = await resolveProject(
    request,
    input.project,
    auth.source === "PERMDOCK_CLOUD_TOKEN",
  );
  if (!project.ok) {
    return project;
  }
  return projectPolicy(request, project.value);
}

type Snapshot = { readonly path: string; readonly bytes: string | null };

function snapshot(path: string): Snapshot {
  return { path, bytes: existsSync(path) ? readFileSync(path, "utf8") : null };
}

function restore(files: readonly Snapshot[]): void {
  for (const file of files) {
    if (file.bytes === null) {
      rmSync(file.path, { force: true });
    } else {
      writeFileEnsuringDir(file.path, file.bytes);
    }
  }
}

export type PullInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly url: string | undefined;
  readonly project: string | undefined;
  readonly manifest: string | undefined;
  readonly json: boolean;
  readonly env: Env;
  readonly io: CliIo;
};

/**
 * Writes the project's catalog and manifest with the writers `collect` and
 * `supabase inspect --out` use, then re-reads the catalog and requires its
 * fingerprint to match what the Cloud sent; a mismatch restores both files.
 */
export async function runCloudPull(input: PullInput): Promise<CommandResult> {
  const fetched = await fetchProjectPolicy({ ...input, command: COMMAND });
  if (!fetched.ok) {
    return fetched.result;
  }
  const pulled = fetched.value;
  let catalog: CatalogDocument;
  try {
    catalog = parseCatalog(pulled.catalog);
  } catch (error) {
    return {
      code: 1,
      output: `${COMMAND}: the Cloud sent an invalid catalog: ${describeError(error)}`,
    };
  }
  let manifestText: string | undefined;
  if (pulled.manifest !== undefined) {
    try {
      manifestText = formatManifestJson(parseSupabaseManifest(pulled.manifest));
    } catch (error) {
      return {
        code: 1,
        output: `${COMMAND}: the Cloud sent an invalid manifest: ${describeError(error)}`,
      };
    }
  }
  const catalogFile = catalogPath(input.config, input.cwd);
  const manifestFile = resolve(input.cwd, input.manifest ?? MANIFEST_FILE);
  const before = [
    snapshot(catalogFile),
    ...(manifestText === undefined ? [] : [snapshot(manifestFile)]),
  ];
  writeFileEnsuringDir(catalogFile, formatCatalogJson(catalog));
  if (manifestText !== undefined) {
    writeFileEnsuringDir(manifestFile, manifestText);
  }
  let written: string;
  try {
    written = catalogFingerprint(
      parseCatalog(readFileSync(catalogFile, "utf8")),
    );
  } catch {
    written = "";
  }
  if (
    written !== pulled.fingerprint ||
    (catalog.fingerprint !== undefined &&
      catalog.fingerprint !== pulled.fingerprint)
  ) {
    restore(before);
    return {
      code: 1,
      output: `${COMMAND}: catalog fingerprint mismatch (Cloud ${pulled.fingerprint}, catalog ${catalog.fingerprint ?? "none"}, written ${written || "unreadable"}); restored the previous files`,
    };
  }
  const local = cliVersion();
  if (pulled.permdockVersion !== local) {
    input.io.stderr(
      `${COMMAND}: pushed by permdock@${pulled.permdockVersion}, pulled by permdock@${local}; regenerate the manifest locally if its shape changed`,
    );
  }
  if (pulled.manifest === undefined) {
    input.io.stderr(
      `${COMMAND}: the push carried no manifest; wrote the catalog only`,
    );
  }
  const catalogRel = relative(input.cwd, catalogFile);
  const manifestRel =
    manifestText === undefined ? null : relative(input.cwd, manifestFile);
  return {
    code: 0,
    output: input.json
      ? JSON.stringify({
          project: pulled.project,
          version: pulled.version,
          fingerprint: pulled.fingerprint,
          permdockVersion: pulled.permdockVersion,
          catalog: catalogRel,
          manifest: manifestRel,
        })
      : `pulled ${pulled.project} version ${String(pulled.version)}: wrote ${catalogRel}${manifestRel === null ? "" : ` and ${manifestRel}`} (${pulled.fingerprint})`,
  };
}
