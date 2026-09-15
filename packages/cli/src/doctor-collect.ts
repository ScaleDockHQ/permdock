import type { Policy } from 'permdock';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasConditionOp } from 'permdock';

import type { DoctorFinding } from './doctor-types.ts';
import type { CliIo, PermDockConfig } from './types.ts';

import { runCollect } from './collect.ts';
import { asPolicy, loadModule, pickNamed } from './load.ts';
import { runUsage } from './usage.ts';

export async function pd002(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<readonly DoctorFinding[]> {
  const collected = await runCollect({
    cwd: input.cwd,
    config: input.config,
    collect: input.config.collect ?? {},
    check: false,
    now: input.now,
    io: input.io,
  });
  if (collected.scan === undefined) {
    return [];
  }
  return collected.scan.unknown.map((usage) => ({
    code: 'PD002',
    severity: 'error' as const,
    message: `unknown permission ${usage.call} at ${usage.file}:${String(usage.line)}`,
    fix: 'use a defined permission reference',
  }));
}

export async function pd003(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const usage = await runUsage({
    cwd: input.cwd,
    config: input.config,
    ignore: [],
    strict: false,
    json: true,
    dynamicAsUsed: false,
    now: input.now,
    io: input.io,
  });
  if (usage.code === 2) {
    return [];
  }
  const report = JSON.parse(usage.output) as {
    readonly ungranted: readonly {
      readonly key: string;
      readonly detail: string;
    }[];
  };
  return report.ungranted.map((item) => ({
    code: 'PD003',
    severity: 'warning' as const,
    message: `${item.key} is used but never granted (${item.detail})`,
    fix: 'add an allow() with a to: selector, or a role() binding, in definePolicy',
  }));
}

export async function pd004(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<readonly DoctorFinding[]> {
  const collected = await runCollect({
    cwd: input.cwd,
    config: input.config,
    collect: input.config.collect ?? {},
    check: true,
    now: input.now,
    io: input.io,
  });
  if (collected.code === 0) {
    return [];
  }
  if (collected.code === 2) {
    return [];
  }
  return [
    {
      code: 'PD004',
      severity: 'error',
      message: collected.message,
      fix: 'pnpm exec permdock collect',
    },
  ];
}

export async function pd016(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  let policy: Policy;
  try {
    policy = asPolicy(
      pickNamed(await loadModule(resolve(input.cwd, input.config.policy)), [
        'policy',
      ]),
    );
  } catch {
    return [];
  }
  const findings: DoctorFinding[] = [];
  let opaque = false;
  let sqlFunction = false;
  for (const grant of policy.grants) {
    if (
      hasConditionOp(grant.where, 'opaque') ||
      hasConditionOp(grant.check, 'opaque')
    ) {
      opaque = true;
    }
    if (
      hasConditionOp(grant.where, 'sqlFunction') ||
      hasConditionOp(grant.check, 'sqlFunction')
    ) {
      sqlFunction = true;
    }
  }
  if (opaque) {
    findings.push({
      code: 'PD016',
      severity: 'warning',
      message: 'policy has opaque RLS conditions that deny in memory',
      fix: 'add rls.functions.<name> with a portable twin, or rewrite as sqlFunction()',
    });
  }
  if (sqlFunction) {
    const fixtures = input.config.rls.fixtures ?? 'rls.fixtures.json';
    if (
      !existsSync(resolve(input.cwd, fixtures)) &&
      !existsSync(resolve(input.cwd, 'rls.fixtures.ts'))
    ) {
      findings.push({
        code: 'PD016',
        severity: 'warning',
        message: 'sqlFunction grants have no rls fixtures for verify --db',
        fix: 'add rls.fixtures.json and run permdock rls verify --db',
      });
    }
  }
  return findings;
}
