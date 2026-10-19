import { run } from "permdock/cli";

type RunOptions = NonNullable<Parameters<typeof run>[1]>;

/**
 * `run` with `--db-url <url>` written as the CLI takes it: `--db-url-stdin`
 * with the URL on stdin. Any other argv runs unchanged.
 */
export function runPipingDbUrl(
  argv: readonly string[],
  options: RunOptions = {},
): ReturnType<typeof run> {
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
