import type { CliIo, RunResult } from './types.ts';

import { flagBool, flagList, flagString, parseArgs } from './args.ts';
import { runCatalog } from './catalog.ts';
import { runCollect } from './collect.ts';
import { loadConfig, resolveCwd } from './config.ts';
import { runDoctor } from './doctor.ts';
import { runSkills } from './skills.ts';
import { runUsage } from './usage.ts';

const HELP = `permdock — @permdock/cli

Commands:
  collect [--check] [--src <path>] [--watch]
  catalog [--format json|schema|markdown] [--from <module>] [--include <key>]
  usage [--json] [--strict] [--ignore <glob>]
  doctor [--json] [--only <codes>] [--fix]
  skills [install|list|update] [--agent <name>]

Global:
  --cwd <dir>   --config <file>   --json   --no-color
`;

export async function run(
  argv: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly io?: CliIo;
  },
): Promise<RunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io: CliIo = options?.io ?? {
    stdout: (text) => {
      stdoutChunks.push(text);
    },
    stderr: (text) => {
      stderrChunks.push(text);
    },
  };
  const writeOut = (text: string): void => {
    const line = text.endsWith('\n') ? text : `${text}\n`;
    io.stdout(line);
    if (options?.io !== undefined) {
      stdoutChunks.push(line);
    }
  };
  const writeErr = (text: string): void => {
    const line = text.endsWith('\n') ? text : `${text}\n`;
    io.stderr(line);
    if (options?.io !== undefined) {
      stderrChunks.push(line);
    }
  };
  const args = parseArgs(argv);
  if (flagBool(args.flags, 'help') || args.command === 'help') {
    writeOut(HELP);
    return finish(0, stdoutChunks, stderrChunks);
  }
  const cwd = resolveCwd(args, options?.cwd ?? process.cwd());
  const now = io.now?.() ?? new Date();
  let config;
  try {
    config = await loadConfig(cwd, args);
  } catch (error) {
    writeErr(error instanceof Error ? error.message : String(error));
    return finish(2, stdoutChunks, stderrChunks);
  }
  const json = flagBool(args.flags, 'json');
  const strict = flagBool(args.flags, 'strict');
  const color = !flagBool(args.flags, 'no-color');
  try {
    switch (args.command) {
      case undefined:
        writeErr(HELP);
        return finish(2, stdoutChunks, stderrChunks);
      case 'collect': {
        const src = flagList(args.flags, 'src');
        const out = flagString(args.flags, 'out');
        const result = await runCollect({
          cwd,
          config,
          collect: {
            ...(src.length > 0 ? { srcPath: src } : {}),
            ...(out === undefined ? {} : { out }),
          },
          check: flagBool(args.flags, 'check'),
          now,
          io,
        });
        writeOut(result.message);
        return finish(result.code, stdoutChunks, stderrChunks);
      }
      case 'catalog': {
        const formatFlag = flagString(args.flags, 'format') ?? 'json';
        if (
          formatFlag !== 'json' &&
          formatFlag !== 'schema' &&
          formatFlag !== 'markdown'
        ) {
          writeErr('catalog --format must be json, schema or markdown');
          return finish(2, stdoutChunks, stderrChunks);
        }
        const result = await runCatalog({
          cwd,
          config,
          format: formatFlag,
          from: flagString(args.flags, 'from'),
          include: flagList(args.flags, 'include'),
          now,
          io,
        });
        writeOut(result.output);
        return finish(result.code, stdoutChunks, stderrChunks);
      }
      case 'usage': {
        const result = await runUsage({
          cwd,
          config,
          ignore: flagList(args.flags, 'ignore'),
          strict,
          json,
          dynamicAsUsed: flagBool(args.flags, 'dynamic-as-used'),
          now,
          io,
        });
        writeOut(result.output);
        return finish(result.code, stdoutChunks, stderrChunks);
      }
      case 'doctor': {
        const result = await runDoctor({
          cwd,
          config,
          only: flagList(args.flags, 'only'),
          json,
          fix: flagBool(args.flags, 'fix'),
          strict,
          color,
          now,
          io,
        });
        writeOut(result.output);
        return finish(result.code, stdoutChunks, stderrChunks);
      }
      case 'skills': {
        const result = runSkills({
          cwd,
          action: args.rest[0],
          agents: flagList(args.flags, 'agent'),
        });
        writeOut(result.output);
        return finish(result.code, stdoutChunks, stderrChunks);
      }
      case 'openapi':
      case 'rls':
        writeErr(
          `'${args.command}' is not in this Phase 1 CLI. Use collect, catalog, usage, doctor or skills.`,
        );
        return finish(2, stdoutChunks, stderrChunks);
      default:
        writeErr(
          `unknown command '${args.command}'. Use collect, catalog, usage, doctor or skills.`,
        );
        return finish(2, stdoutChunks, stderrChunks);
    }
  } catch (error) {
    writeErr(error instanceof Error ? error.message : String(error));
    return finish(2, stdoutChunks, stderrChunks);
  }
}

function finish(
  code: 0 | 1 | 2,
  stdout: readonly string[],
  stderr: readonly string[],
): RunResult {
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}
