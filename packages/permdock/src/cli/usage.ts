import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Condition, Policy } from '../index.ts';
import type {
  CatalogUsage,
  CliIo,
  PermDockConfig,
  ScanResult,
} from './types.ts';

import { getResource } from '../index.ts';
import { jsonSchemaOf } from './catalog-doc.ts';
import { runCollect } from './collect.ts';
import { isClientSource } from './doctor-source.ts';
import { listSourceFiles, rel } from './files.ts';
import { asPolicy, loadModule, pickNamed } from './load.ts';
import { USAGE_REPORT_SCHEMA } from './version.ts';

export type UsageFinding = {
  readonly kind:
    | 'unused'
    | 'ungranted'
    | 'no-role'
    | 'dynamic'
    | 'undeclared-field'
    | 'outside-include';
  readonly key: string;
  readonly detail: string;
};

export type UsageReport = {
  readonly $schema: typeof USAGE_REPORT_SCHEMA;
  readonly unused: readonly UsageFinding[];
  readonly ungranted: readonly UsageFinding[];
  readonly noRole: readonly UsageFinding[];
  readonly dynamic: readonly UsageFinding[];
  readonly undeclared: readonly UsageFinding[];
  readonly outsideInclude: readonly UsageFinding[];
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
  for (const grant of policy.grants ?? []) {
    if (grant.effect === 'allow') {
      granted.add(grant.permission.key);
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
  const undeclared = undeclaredFields(policy).filter(
    (finding) => !ignored(finding.key, input.ignore),
  );
  const outsideInclude = outsideSnapshotInclude(
    input.cwd,
    input.config,
    collected.scan,
    usedAt,
  ).filter((finding) => !ignored(finding.key, input.ignore));
  const report: UsageReport = {
    $schema: USAGE_REPORT_SCHEMA,
    unused,
    ungranted,
    noRole,
    dynamic,
    undeclared,
    outsideInclude,
    warnings:
      unused.length +
      ungranted.length +
      dynamic.length +
      undeclared.length +
      outsideInclude.length,
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

const CLIENT_CALLS = new Set([
  'usePermission',
  'can',
  'decide',
  'filter',
  'actions',
]);

function undeclaredFields(policy: Policy): readonly UsageFinding[] {
  const findings: UsageFinding[] = [];
  for (const grant of policy.grants) {
    const declared = declaredFields(policy, grant.permission.resource);
    if (declared === undefined) {
      continue;
    }
    const fields = new Set<string>();
    conditionFields(grant.where, fields);
    conditionFields(grant.check, fields);
    for (const field of fields) {
      if (!declared.has(field)) {
        findings.push({
          kind: 'undeclared-field',
          key: grant.permission.key,
          detail: `${grant.role === null ? 'policy grant' : `role '${grant.role}'`} reads '${field}', which the ${grant.permission.resource} schema does not declare`,
        });
      }
    }
  }
  return findings;
}

function declaredFields(
  policy: Policy,
  resource: string,
): ReadonlySet<string> | undefined {
  const node = getResource(policy.permissions, resource);
  const schema = node === undefined ? null : jsonSchemaOf(node);
  if (schema === null || typeof schema !== 'object') {
    return undefined;
  }
  const properties = (schema as { readonly properties?: unknown }).properties;
  if (properties === null || typeof properties !== 'object') {
    return undefined;
  }
  return new Set(Object.keys(properties));
}

function conditionFields(
  condition: Condition | undefined,
  out: Set<string>,
): void {
  if (condition === undefined) {
    return;
  }
  const add = (field: string): void => {
    out.add(field.split('.')[0] ?? field);
  };
  switch (condition.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains':
    case 'in':
    case 'notIn':
    case 'isNull': {
      add(condition.field);
      break;
    }
    case 'and':
    case 'or': {
      for (const child of condition.conditions) {
        conditionFields(child, out);
      }
      break;
    }
    case 'not': {
      conditionFields(condition.condition, out);
      break;
    }
    case 'memberOf': {
      add(condition.field);
      for (const parent of condition.parents ?? []) {
        add(typeof parent === 'string' ? parent : parent.field);
      }
      break;
    }
    case 'sqlFunction': {
      for (const arg of condition.args) {
        if (
          arg !== null &&
          typeof arg === 'object' &&
          !Array.isArray(arg) &&
          'field' in arg
        ) {
          add(arg.field);
        }
      }
      conditionFields(condition.twin, out);
      break;
    }
    case 'opaque': {
      break;
    }
    default: {
      const exhaustive: never = condition;
      throw new Error(`unknown condition ${String(exhaustive)}`);
    }
  }
}

function outsideSnapshotInclude(
  cwd: string,
  config: PermDockConfig,
  scan: ScanResult,
  usedAt: Readonly<Record<string, readonly CatalogUsage[]>>,
): readonly UsageFinding[] {
  if (
    scan.snapshots.length === 0 ||
    scan.snapshots.some(
      (site) => site.include === undefined || site.include === null,
    )
  ) {
    return [];
  }
  const include = scan.snapshots.flatMap((site) => site.include ?? []);
  const clientEntries = new Set(
    listSourceFiles(cwd, config.doctor?.clientEntries ?? []).map((file) =>
      rel(cwd, file),
    ),
  );
  const client = new Map<string, boolean>();
  const isClient = (file: string): boolean => {
    let known = client.get(file);
    if (known === undefined) {
      const path = resolve(cwd, file);
      known =
        existsSync(path) &&
        isClientSource(
          { file, text: readFileSync(path, 'utf8') },
          clientEntries,
        );
      client.set(file, known);
    }
    return known;
  };
  const findings: UsageFinding[] = [];
  for (const [key, sites] of Object.entries(usedAt)) {
    if (include.some((item) => key === item || key.startsWith(`${item}.`))) {
      continue;
    }
    const site = sites.find(
      (usage) => CLIENT_CALLS.has(usage.call) && isClient(usage.file),
    );
    if (site !== undefined) {
      findings.push({
        kind: 'outside-include',
        key,
        detail: `${site.file}:${String(site.line)} (${site.call}) is outside every snapshot include`,
      });
    }
  }
  return findings;
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
  for (const [title, list] of [
    ['conditions on undeclared fields', report.undeclared],
    ['client checks outside include', report.outsideInclude],
  ] as const) {
    if (list.length > 0) {
      lines.push('');
      lines.push(`  ${title} (${String(list.length)})`);
      for (const finding of list) {
        lines.push(`    ${finding.key.padEnd(28)} ${finding.detail}`);
      }
    }
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
