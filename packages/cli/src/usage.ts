import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CatalogUsage, CliIo, PermDockConfig } from './types.ts';

import { runCollect } from './collect.ts';
import { asPolicy, loadModule, pickNamed } from './load.ts';
import { USAGE_REPORT_SCHEMA } from './version.ts';

export type UsageFinding = {
  readonly kind: 'unused' | 'ungranted' | 'no-role' | 'dynamic';
  readonly key: string;
  readonly detail: string;
};

export type UsageReport = {
  readonly $schema: typeof USAGE_REPORT_SCHEMA;
  readonly unused: readonly UsageFinding[];
  readonly ungranted: readonly UsageFinding[];
  readonly noRole: readonly UsageFinding[];
  readonly dynamic: readonly UsageFinding[];
  readonly warnings: number;
  readonly errors: number;
};

export async function runUsage(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly ignore: readonly string[];
  readonly strict: boolean;
  readonly json: boolean;
  readonly dynamicAsUsed: boolean;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const collected = await runCollect({
    cwd: input.cwd,
    config: input.config,
    collect: input.config.collect ?? {},
    check: false,
    now: input.now,
    io: input.io,
  });
  if (collected.document === undefined || collected.scan === undefined) {
    return { code: 2, output: collected.message };
  }
  const policyRel = input.config.policy;
  if (policyRel === undefined) {
    return { code: 2, output: 'usage: set policy in permdock.config.ts' };
  }
  const policyAbs = resolve(input.cwd, policyRel);
  if (!existsSync(policyAbs)) {
    return {
      code: 2,
      output: `PermDock CLI: policy module not found: ${policyRel}`,
    };
  }
  const policy = asPolicy(pickNamed(await loadModule(policyAbs), ['policy']));
  const granted = new Set<string>();
  const mergedRoles = new Set<string>();
  for (const role of policy.roles) {
    mergedRoles.add(role.name);
    for (const grant of role.grants) {
      if (grant.effect === 'allow') {
        granted.add(grant.permission.key);
      }
    }
  }
  const used = new Set<string>();
  const usedAt: Record<string, readonly CatalogUsage[]> = {};
  for (const permission of collected.document.permissions) {
    if (permission.usages.some((usage) => usage.call !== 'allow')) {
      used.add(permission.key);
      usedAt[permission.key] = permission.usages;
    }
  }
  const unused: UsageFinding[] = [];
  const ungranted: UsageFinding[] = [];
  const noRole: UsageFinding[] = [];
  const dynamic: UsageFinding[] = [];
  for (const permission of collected.document.permissions) {
    const key = permission.key;
    if (ignored(key, input.ignore)) {
      continue;
    }
    if (!used.has(key) && !input.dynamicAsUsed) {
      unused.push({
        kind: 'unused',
        key,
        detail: permission.usages[0]?.file ?? 'defined',
      });
    }
    if (used.has(key) && !granted.has(key)) {
      const site = usedAt[key]?.[0];
      ungranted.push({
        kind: 'ungranted',
        key,
        detail:
          site === undefined
            ? 'checked'
            : `${site.file}:${String(site.line)} (${site.call})`,
      });
    }
  }
  for (const name of collected.scan.roleNames) {
    if (!mergedRoles.has(name)) {
      noRole.push({
        kind: 'no-role',
        key: name,
        detail: `role '${name}' not passed to definePolicy`,
      });
    }
  }
  for (const site of collected.scan.dynamic) {
    dynamic.push({
      kind: 'dynamic',
      key: '*',
      detail: `${site.file}:${String(site.line)} (${site.call})`,
    });
  }
  const report: UsageReport = {
    $schema: USAGE_REPORT_SCHEMA,
    unused,
    ungranted,
    noRole,
    dynamic,
    warnings: unused.length + ungranted.length + dynamic.length,
    errors: noRole.length,
  };
  const code: 0 | 1 =
    report.errors > 0 || (input.strict && report.warnings > 0) ? 1 : 0;
  return {
    code,
    output: input.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatUsage(report),
  };
}

function ignored(key: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('.*')) {
      return key.startsWith(pattern.slice(0, -2));
    }
    return key === pattern;
  });
}

function formatUsage(report: UsageReport): string {
  const lines = ['permdock usage', ''];
  lines.push(`  defined but unused (${String(report.unused.length)})`);
  for (const finding of report.unused) {
    lines.push(`    ${finding.key.padEnd(28)} ${finding.detail}`);
  }
  lines.push('');
  lines.push(`  used but ungranted (${String(report.ungranted.length)})`);
  for (const finding of report.ungranted) {
    lines.push(`    ${finding.key.padEnd(28)} ${finding.detail}`);
  }
  lines.push('');
  lines.push(`  granted by no role (${String(report.noRole.length)})`);
  for (const finding of report.noRole) {
    lines.push(`    ${finding.key.padEnd(28)} ${finding.detail}`);
  }
  if (report.dynamic.length > 0) {
    lines.push('');
    lines.push(`  dynamic (${String(report.dynamic.length)})`);
    for (const finding of report.dynamic) {
      lines.push(`    ${finding.detail}`);
    }
  }
  lines.push('');
  lines.push(
    `  ${String(report.warnings)} warning${report.warnings === 1 ? '' : 's'}, ${String(report.errors)} error${report.errors === 1 ? '' : 's'}`,
  );
  return `${lines.join('\n')}\n`;
}
