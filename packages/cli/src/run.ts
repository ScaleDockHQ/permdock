import type { CliIo, RunResult } from './types.ts';

import { runArazzo } from './arazzo.ts';
import { flagBool, flagList, flagString, parseArgs } from './args.ts';
import { runCatalog } from './catalog.ts';
import { runCollect } from './collect.ts';
import { loadConfig, resolveCwd } from './config.ts';
import { runDoctor } from './doctor.ts';
import { runOpenapi } from './openapi.ts';
import { runRls } from './rls.ts';
import { runSkills } from './skills.ts';
import { runUsage } from './usage.ts';

const HELP = `permdock — @permdock/cli

Commands:
  collect [--check] [--src <path>] [--watch]
  catalog [--format json|schema|markdown] [--from <module>] [--include <key>]
  usage [--json] [--strict] [--ignore <glob>]
  doctor [--json] [--only <codes>] [--fix]
  skills [install|list|update] [--agent <name>]
  openapi emit --doc <path> [--target 3.1|3.2|3.3] [--format document|overlay]
  rls generate|import|verify [--target sql|drizzle|prisma] [--dialect supabase|neon|guc]
  arazzo check --doc <arazzo.json> --openapi <doc.json> [--workflow <id>] [--from <module>]

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
      case 'openapi': {
        const targetFlag = flagString(args.flags, 'target') ?? '3.2';
        if (
          targetFlag !== '3.1' &&
          targetFlag !== '3.2' &&
          targetFlag !== '3.3'
        ) {
          writeErr('openapi --target must be 3.1, 3.2 or 3.3');
          return finish(2, stdoutChunks, stderrChunks);
        }
        const formatFlag = flagString(args.flags, 'format') ?? 'document';
        if (formatFlag !== 'document' && formatFlag !== 'overlay') {
          writeErr('openapi --format must be document or overlay');
          return finish(2, stdoutChunks, stderrChunks);
        }
        const overlayFlag = flagString(args.flags, 'overlay') ?? '1.1';
        if (overlayFlag !== '1.1' && overlayFlag !== '1.2') {
          writeErr('openapi --overlay must be 1.1 or 1.2');
          return finish(2, stdoutChunks, stderrChunks);
        }
        const profileFlag = flagString(args.flags, 'profile');
        if (profileFlag !== undefined && profileFlag !== 'fapi2') {
          writeErr('openapi --profile must be fapi2');
          return finish(2, stdoutChunks, stderrChunks);
        }
        const result = await runOpenapi({
          cwd,
          config,
          rest: args.rest,
          doc: flagString(args.flags, 'doc') ?? flagList(args.flags, 'doc')[0],
          out: flagString(args.flags, 'out'),
          from: flagString(args.flags, 'from'),
          target: targetFlag,
          format: formatFlag,
          overlay: overlayFlag,
          check: flagBool(args.flags, 'check'),
          profile: profileFlag,
          profileScheme: flagString(args.flags, 'profile-scheme'),
          scheme: flagString(args.flags, 'scheme') ?? 'permdockOAuth',
          metadataUrl: flagList(args.flags, 'metadata-url')[0],
          deviceFlow: flagBool(args.flags, 'device-flow'),
          io,
        });
        writeOut(result.output);
        return finish(result.code, stdoutChunks, stderrChunks);
      }
      case 'arazzo': {
        const result = await runArazzo({
          cwd,
          config,
          rest: args.rest,
          doc: flagString(args.flags, 'doc') ?? flagList(args.flags, 'doc')[0],
          openapi: flagString(args.flags, 'openapi'),
          workflow: flagString(args.flags, 'workflow'),
          from: flagString(args.flags, 'from'),
          json,
        });
        writeOut(result.output);
        return finish(result.code, stdoutChunks, stderrChunks);
      }
      case 'rls': {
        const rbacFlag = flagString(args.flags, 'rbac');
        const result = await runRls({
          cwd,
          config,
          rest: args.rest,
          target: flagString(args.flags, 'target'),
          dialect: flagString(args.flags, 'dialect'),
          out: flagString(args.flags, 'out'),
          from: flagString(args.flags, 'from'),
          sql: flagString(args.flags, 'sql'),
          db: flagString(args.flags, 'db'),
          fixtures: flagString(args.flags, 'fixtures'),
          schema: flagString(args.flags, 'schema'),
          memberships: flagString(args.flags, 'memberships'),
          format:
            flagString(args.flags, 'format') ?? flagString(args.flags, 'emit'),
          rbac:
            flagBool(args.flags, 'rbac-scaffold') || rbacFlag === 'supabase',
          check: flagBool(args.flags, 'check'),
          skipClosures: flagBool(args.flags, 'skip-closures'),
          inlineFunctions: flagBool(args.flags, 'inline-functions'),
          gucPrefix: flagString(args.flags, 'guc-prefix'),
          io,
        });
        writeOut(result.output);
        return finish(result.code, stdoutChunks, stderrChunks);
      }
      default:
        writeErr(
          `unknown command '${args.command}'. Use collect, catalog, usage, doctor, skills, openapi, rls or arazzo.`,
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
