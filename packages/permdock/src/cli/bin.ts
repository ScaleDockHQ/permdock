#!/usr/bin/env node
import { run } from "./run.ts";
import { streamHasColors } from "./style.ts";

const result = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  io: {
    env: process.env,
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
      process.env["CI"] === undefined,
  },
});

// An interrupted --db command has set 130 already.
process.exitCode ??= result.code;
