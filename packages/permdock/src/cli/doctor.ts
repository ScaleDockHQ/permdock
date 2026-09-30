import { readFileSync } from 'node:fs';

import type { DoctorFinding } from './doctor-types.ts';
import type { CliIo, PermDockConfig } from './types.ts';

import { runCollect } from './collect.ts';
import {
  pd002,
  pd003,
  pd004,
  pd016,
  pd017,
  pd018,
  pd019,
  pd020,
  pd021,
  pd023,
  pd024,
  pd025,
  pd026,
  pd027,
  pd029,
  pd030,
  pd031,
  pd032,
  pd033,
  pd034,
  pd035,
  pd037,
} from './doctor-collect.ts';
import { pd005, pd006, pd009, pd012, pd022, pd028 } from './doctor-project.ts';
import {
  pd001,
  pd007,
  pd008,
  pd010,
  pd011,
  pd013,
  pd014,
  pd015,
} from './doctor-source.ts';
import { defaultSrcPath, listSourceFiles, rel } from './files.ts';
import { runSkillsInstall } from './skills.ts';
import { attrsPlan } from './supabase-hook.ts';
import { DOCTOR_REPORT_SCHEMA } from './version.ts';

export type { DoctorFinding, DoctorSeverity } from './doctor-types.ts';

export type DoctorReport = {
  readonly $schema: typeof DOCTOR_REPORT_SCHEMA;
  readonly findings: readonly DoctorFinding[];
  readonly errors: number;
  readonly warnings: number;
};

export async function runDoctor(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly only: readonly string[];
  readonly json: boolean;
  readonly fix: boolean;
  readonly strict: boolean;
  readonly color: boolean;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  if (input.fix) {
    runSkillsInstall({
      cwd: input.cwd,
      agents: [],
    });
    await runCollect({
      cwd: input.cwd,
      config: input.config,
      collect: input.config.collect ?? {},
      check: false,
      now: input.now,
      io: input.io,
    });
  }
  const findings: DoctorFinding[] = [];
  const wanted = new Set(input.only);
  const include = (group: string): boolean =>
    wanted.size === 0 || wanted.has(group) || wanted.has(group.toLowerCase());

  const srcPath = input.config.collect?.srcPath ?? defaultSrcPath();
  const files = listSourceFiles(input.cwd, srcPath);
  const sources = files.map((file) => ({
    file: rel(input.cwd, file),
    text: readFileSync(file, 'utf8'),
  }));

  if (include('imports') || include('PD001')) {
    const clientEntries = new Set(
      listSourceFiles(input.cwd, input.config.doctor?.clientEntries ?? []).map(
        (file) => rel(input.cwd, file),
      ),
    );
    findings.push(...pd001(sources, clientEntries));
  }
  if (include('references') || include('PD002')) {
    findings.push(...(await pd002(input)));
  }
  if (include('ungranted') || include('PD003')) {
    findings.push(...(await pd003(input)));
  }
  if (include('catalog') || include('PD004')) {
    findings.push(...(await pd004(input)));
  }
  if (include('skills') || include('PD005')) {
    findings.push(...pd005(input.cwd));
  }
  if (include('typescript') || include('PD006')) {
    findings.push(...pd006(input.cwd));
  }
  if (include('validation') || include('PD007')) {
    findings.push(...pd007(sources));
  }
  if (include('naming') || include('PD008')) {
    findings.push(...pd008(sources));
  }
  if (include('duplicates') || include('PD009')) {
    findings.push(...pd009(input.cwd));
  }
  if (include('claims') || include('PD010')) {
    findings.push(...pd010(sources));
  }
  if (include('tenant') || include('PD011')) {
    findings.push(...pd011(sources));
  }
  if (include('drafts') || include('PD012')) {
    findings.push(...pd012(input.cwd, input.config));
  }
  if (include('algorithms') || include('PD013')) {
    findings.push(...pd013(sources));
  }
  if (include('discovery') || include('PD014')) {
    findings.push(...pd014(sources));
  }
  if (include('typ') || include('PD015')) {
    findings.push(...pd015(sources));
  }
  if (include('rls') || include('PD016')) {
    findings.push(...(await pd016(input)));
  }
  if (include('sensitive') || include('PD017')) {
    findings.push(...(await pd017(input)));
  }
  if (include('separation') || include('PD018')) {
    findings.push(...(await pd018(input)));
  }
  if (include('jwt-roles') || include('PD019')) {
    findings.push(...(await pd019(input)));
  }
  if (include('hosted') || include('PD020')) {
    findings.push(...(await pd020(input)));
  }
  if (include('hosted') || include('PD021')) {
    findings.push(
      ...(await pd021({ ...input, env: input.io.env ?? process.env })),
    );
  }
  if (include('views') || include('PD022')) {
    findings.push(...pd022(input.cwd, input.config));
  }
  if (include('custom-roles') || include('PD023')) {
    findings.push(...(await pd023(input)));
  }
  if (include('self-approval') || include('PD024')) {
    findings.push(...(await pd024(input)));
  }
  if (include('scopes') || include('PD025')) {
    findings.push(...(await pd025(input)));
  }
  if (include('ownership') || include('PD026')) {
    findings.push(...(await pd026(input)));
  }
  if (include('rls') || include('context-refs') || include('PD027')) {
    findings.push(...(await pd027(input)));
  }
  if (include('attrs') || include('supabase') || include('PD028')) {
    findings.push(...pd028(input.cwd, input.config, attrsPlan));
  }
  if (include('credentials') || include('PD029')) {
    findings.push(...pd029(input));
  }
  if (include('fields') || include('PD030')) {
    findings.push(...(await pd030(input)));
  }
  if (include('graph') || include('PD031')) {
    findings.push(...(await pd031(input)));
  }
  if (include('graph') || include('rls') || include('PD032')) {
    findings.push(...(await pd032(input)));
  }
  if (include('activation') || include('PD033')) {
    findings.push(...(await pd033(input)));
  }
  if (include('break-glass') || include('PD034')) {
    findings.push(...(await pd034(input)));
  }
  if (include('support') || include('PD035')) {
    findings.push(...(await pd035(input)));
  }
  if (include('supabase') || include('row-conditions') || include('PD037')) {
    findings.push(...(await pd037(input)));
  }

  const errors = findings.filter((item) => item.severity === 'error').length;
  const warnings = findings.filter(
    (item) => item.severity === 'warning',
  ).length;
  const report: DoctorReport = {
    $schema: DOCTOR_REPORT_SCHEMA,
    findings,
    errors,
    warnings,
  };
  const code: 0 | 1 = errors > 0 || (input.strict && warnings > 0) ? 1 : 0;
  return {
    code,
    output: input.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatDoctor(report, input.color),
  };
}

function formatDoctor(report: DoctorReport, color: boolean): string {
  const errorMark = color ? '✖' : 'error';
  const warnMark = color ? '⚠' : 'warn';
  const lines = ['permdock doctor', ''];
  for (const finding of report.findings) {
    const mark = finding.severity === 'error' ? errorMark : warnMark;
    lines.push(`  ${mark} ${finding.code}  ${finding.message}`);
    lines.push(`           fix: ${finding.fix}`);
  }
  if (report.findings.length === 0) {
    lines.push('  no findings');
  }
  lines.push('');
  lines.push(
    `  ${String(report.errors)} error${report.errors === 1 ? '' : 's'}, ${String(report.warnings)} warning${report.warnings === 1 ? '' : 's'}`,
  );
  return `${lines.join('\n')}\n`;
}
