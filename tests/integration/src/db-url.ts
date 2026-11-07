import { run } from "permdock/cli";

import { hookGenerate, rlsGenerate } from "./support/rls.ts";

type RunOptions = NonNullable<Parameters<typeof run>[1]>;

/**
 * `run` with `--db-url <url>` written as the CLI takes it: `--db-url-stdin`
 * with the URL on stdin. `rls generate` and `supabase hook generate` run as
 * `generate --only`. Any other argv runs unchanged.
 */
export function runPipingDbUrl(
  argv: readonly string[],
  options: RunOptions = {},
): ReturnType<typeof run> {
  const cwd = options.cwd;
  if (argv[0] === "rls" && argv[1] === "generate") {
    return rlsGenerate(argv.slice(2), cwd === undefined ? {} : { cwd });
  }
  if (argv[0] === "supabase" && argv[1] === "hook" && argv[2] === "generate") {
    return hookGenerate(argv.slice(3), cwd === undefined ? {} : { cwd });
  }
  const at = argv.indexOf("--db-url");
  const url = at === -1 ? undefined : argv[at + 1];
  if (url === undefined) {
    return run(argv, options);
  }
  const discarded: string[] = [];
  return run([...argv.slice(0, at), "--db-url-stdin", ...argv.slice(at + 2)], {
    ...options,
    io: {
      stdout: (text) => {
        discarded.push(text);
      },
      stderr: (text) => {
        discarded.push(text);
      },
      ...options.io,
      readStdin: () => Promise.resolve(url),
    },
  });
}
