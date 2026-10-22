import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The official JSON Schemas `permdock openapi` output is validated against.
// Each URL is the schema's `$id`; bumping a revision means changing it here.
const SCHEMAS = {
  "oas-3.1.json": "https://spec.openapis.org/oas/3.1/schema/2022-10-07",
  "oas-3.2.json": "https://spec.openapis.org/oas/3.2/schema/2025-09-17",
  "overlay-1.1.json": "https://spec.openapis.org/overlay/1.1/schema/2026-04-01",
} as const;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages", "permdock", "schemas", "openapi");
const check = process.argv.includes("--check");

async function fetchSchema(
  dir: string,
  file: string,
  url: string,
): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "application/schema+json, application/json" },
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)}`);
  }
  const target = join(dir, file);
  await writeFile(
    target,
    `${JSON.stringify(await response.json(), null, 2)}\n`,
  );
  return target;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

const staging = await mkdtemp(join(tmpdir(), "permdock-openapi-"));
try {
  const files = Object.keys(SCHEMAS);
  const staged = await Promise.all(
    Object.entries(SCHEMAS).map(
      async ([file, url]: readonly [string, string]) => {
        const target = await fetchSchema(staging, file, url);
        return target;
      },
    ),
  );
  execFileSync(
    join(root, "node_modules", ".bin", "oxfmt"),
    ["--config", join(root, "oxfmt.config.ts"), ...staged],
    { cwd: staging, stdio: "inherit" },
  );

  if (check) {
    const compared = await Promise.all(
      files.map(async (file) => {
        const [fresh, committed] = await Promise.all([
          readFile(join(staging, file), "utf8"),
          readOrEmpty(join(out, file)),
        ]);
        return fresh === committed ? undefined : join(out, file);
      }),
    );
    const stale = compared.filter((path) => path !== undefined);
    if (stale.length > 0) {
      process.stderr.write(
        `OpenAPI schemas differ from upstream; run \`pnpm openapi:generate\`:\n${stale.map((path) => `  ${path}`).join("\n")}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write("OpenAPI schemas match upstream\n");
    }
  } else {
    await Promise.all(
      files.map(async (file) => {
        const target = join(out, file);
        await copyFile(join(staging, file), target);
        process.stdout.write(`wrote ${target}\n`);
      }),
    );
  }
} finally {
  await rm(staging, { force: true, recursive: true });
}
