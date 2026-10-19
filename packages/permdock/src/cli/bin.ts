#!/usr/bin/env node
import { isCi } from "./core/env.ts";
import { trapSignals } from "./core/signals.ts";
import { run } from "./run.ts";
import { streamHasColors } from "./style.ts";

const signals = trapSignals();
const result = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  io: {
    env: process.env,
    signal: signals.signal,
    stdout: (text) => {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    stderr: (text) => {
      process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    color: streamHasColors(process.stdout),
    interactive:
      process.stdin.isTTY === true &&
      process.stdout.isTTY === true &&
      !isCi(process.env),
  },
});
signals.dispose();

// A signal has set 130 or 143 already.
process.exitCode ??= result.code;
