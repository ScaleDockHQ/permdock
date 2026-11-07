import { spawnSync } from "node:child_process";

/**
 * `next build` for an example app, failing on a prerender or instant-navigation
 * message. Next.js prints these as warnings with a `docs/messages/<code>` link;
 * the code is the part this matches.
 */
const BLOCKING = /\b(?:blocking-prerender|instant)-[a-z][a-z-]*\b/gu;

const result = spawnSync("pnpm", ["exec", "next", "build"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status === 0) {
  const found = [
    ...new Set(`${result.stdout}\n${result.stderr}`.match(BLOCKING) ?? []),
  ];
  if (found.length > 0) {
    process.stderr.write(
      `next build printed ${found.join(", ")}. A route blocks its prerender or its instant navigation; fix it, or give the route a Suspense boundary.\n`,
    );
    process.exitCode = 1;
  }
} else {
  process.exitCode = result.status ?? 1;
}
