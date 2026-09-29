import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PermissionTree } from '../index.ts';
import type { PermDockConfig } from './types.ts';

import { arazzoFindings } from '../index.ts';
import { asPermissionTree, loadModule, pickNamed } from './load.ts';

export async function runArazzo(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly doc: string | undefined;
  readonly openapi: string | undefined;
  readonly workflow: string | undefined;
  readonly from: string | undefined;
  readonly json: boolean;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const action = input.rest[0];
  if (action !== 'check') {
    return {
      code: 2,
      output: 'permdock arazzo check --doc <arazzo> --openapi <doc>',
    };
  }
  const docPath = input.doc;
  const openapiPath = input.openapi;
  if (docPath === undefined || openapiPath === undefined) {
    return {
      code: 2,
      output: 'arazzo check requires --doc and --openapi',
    };
  }
  const arazzoFile = resolve(input.cwd, docPath);
  const openapiFile = resolve(input.cwd, openapiPath);
  if (!existsSync(arazzoFile) || !existsSync(openapiFile)) {
    return { code: 2, output: 'arazzo check: document not found' };
  }
  let arazzo: unknown;
  let openapi: unknown;
  try {
    arazzo = JSON.parse(readFileSync(arazzoFile, 'utf8'));
    openapi = JSON.parse(readFileSync(openapiFile, 'utf8'));
  } catch {
    return { code: 2, output: 'arazzo check: unreadable JSON' };
  }
  const from = input.from ?? input.config.permissions;
  let tree: PermissionTree | undefined;
  if (from !== undefined) {
    const abs = resolve(input.cwd, from);
    if (!existsSync(abs)) {
      return {
        code: 2,
        output: `arazzo check: permissions not found: ${from}`,
      };
    }
    const mod = await loadModule(abs);
    tree = asPermissionTree(pickNamed(mod, ['permissions']));
  }
  const findings = arazzoFindings(
    input.workflow === undefined
      ? { arazzo, openapi }
      : { arazzo, openapi, workflowId: input.workflow },
    tree,
  );
  if (input.json) {
    return {
      code: findings.length === 0 ? 0 : 1,
      output: JSON.stringify({ $schema: 'permdock-arazzo-check', findings }),
    };
  }
  if (findings.length === 0) {
    return { code: 0, output: 'arazzo check: all steps documented' };
  }
  const lines = findings.map(
    (finding) =>
      `${finding.workflowId} ${finding.stepId}: ${finding.reason} (${finding.detail})`,
  );
  return { code: 1, output: lines.join('\n') };
}
