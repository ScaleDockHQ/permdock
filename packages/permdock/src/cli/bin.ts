#!/usr/bin/env node
import module from "node:module";
import { text } from "node:stream/consumers";

module.enableCompileCache?.();

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
  // Lazy: `--version` loads only the version reader, not the CLI core.
  const { cliVersion } = await import("./core/version.ts");
  process.stdout.write(`${cliVersion()}\n`);
} else {
  // Lazy: the compile cache is on only after the line above, so the CLI core loads after it.
  const [{ isCi }, { trapSignals }, { run }, { streamHasColors }] =
    await Promise.all([
      import("./core/env.ts"),
      import("./core/signals.ts"),
      import("./core/run.ts"),
      import("./core/style.ts"),
    ]);
  const signals = trapSignals();
  const result = await run(argv, {
    cwd: process.cwd(),
    io: {
      env: process.env,
      signal: signals.signal,
      stdout: (chunk) => {
        process.stdout.write(chunk);
      },
      stderr: (chunk) => {
        process.stderr.write(chunk);
      },
      color: streamHasColors(process.stdout),
      errColor: streamHasColors(process.stderr),
      stdoutIsTty: process.stdout.isTTY === true,
      stderrIsTty: process.stderr.isTTY === true,
      readStdin: () => text(process.stdin),
      interactive:
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true &&
        !isCi(process.env),
    },
  });
  signals.dispose();
  // A signal has set 130 or 143 already.
  process.exitCode ??= result.code;
}
