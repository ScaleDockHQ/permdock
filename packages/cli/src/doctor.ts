import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import type { CliIo, PermDockConfig } from './types.ts';

import { runCollect } from './collect.ts';
import { defaultSrcPath, listSourceFiles, rel } from './files.ts';
import { runSkillsInstall } from './skills.ts';
import { runUsage } from './usage.ts';
import { DOCTOR_REPORT_SCHEMA } from './version.ts';

export type DoctorSeverity = 'error' | 'warning';

export type DoctorFinding = {
  readonly code: string;
  readonly severity: DoctorSeverity;
  readonly message: string;
  readonly fix: string;
};

export type DoctorReport = {
  readonly $schema: typeof DOCTOR_REPORT_SCHEMA;
  readonly findings: readonly DoctorFinding[];
  readonly errors: number;
  readonly warnings: number;
};

const SERVER_SPECIFIERS = [
  'permdock/server',
  'permdock/next',
  'permdock/hono',
  'permdock/mcp',
  'permdock/approvals',
  'permdock/jwt',
  'permdock/supabase',
  'permdock/ai-sdk',
  'permdock/claude-agent',
  'permdock/eve',
  'permdock/openai',
] as const;

const ADAPTER_SPECIFIERS = [
  'permdock/hono',
  'permdock/next',
  'permdock/mcp',
  'permdock/ai-sdk',
  'permdock/claude-agent',
  'permdock/express',
  'permdock/fastify',
] as const;

const UNTRUSTED_CLAIMS = [
  'user_metadata',
  'unsafeMetadata',
  'untrusted_metadata',
  'clientMetadata',
  'preferred_username',
] as const;

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
    findings.push(...pd001(sources));
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

function pd001(
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    const isClient =
      source.text.includes("'use client'") ||
      source.text.includes('"use client"') ||
      source.file.includes('.client.');
    if (!isClient) {
      continue;
    }
    for (const spec of SERVER_SPECIFIERS) {
      if (
        source.text.includes(`'${spec}'`) ||
        source.text.includes(`"${spec}"`)
      ) {
        findings.push({
          code: 'PD001',
          severity: 'error',
          message: `${source.file} imports ${spec}`,
          fix: "move the check into a Server Component or import from 'permdock/react'",
        });
      }
    }
  }
  return findings;
}

async function pd002(input: {
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

async function pd003(input: {
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
    fix: 'add an allow() for this permission to a role passed to definePolicy',
  }));
}

async function pd004(input: {
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

function pd005(cwd: string): readonly DoctorFinding[] {
  const lockPath = join(cwd, '.permdock/skills-lock.json');
  const folders = [
    join(cwd, '.agents/skills'),
    join(cwd, '.claude/skills'),
    join(cwd, '.cursor/skills'),
  ];
  const installed = folders.some((folder) =>
    existsSync(join(folder, 'wire-permdock/SKILL.md')),
  );
  if (!installed) {
    return [
      {
        code: 'PD005',
        severity: 'warning',
        message: 'Agent Skills are not installed',
        fix: 'pnpm exec permdock skills install',
      },
    ];
  }
  if (!existsSync(lockPath)) {
    return [
      {
        code: 'PD005',
        severity: 'warning',
        message: 'skills lock is missing',
        fix: 'pnpm exec permdock skills install',
      },
    ];
  }
  return [];
}

function pd006(cwd: string): readonly DoctorFinding[] {
  try {
    const require = createRequire(resolve(cwd, 'package.json'));
    const pkg = require('typescript/package.json') as {
      readonly version: string;
    };
    const major = Number(pkg.version.split('.')[0]);
    if (major < 5 || (major === 5 && Number(pkg.version.split('.')[1]) < 9)) {
      return [
        {
          code: 'PD006',
          severity: 'error',
          message: `TypeScript ${pkg.version} is below the supported matrix (5.9, 6, 7)`,
          fix: 'upgrade typescript to 5.9 or later',
        },
      ];
    }
    if (major > 7) {
      return [
        {
          code: 'PD006',
          severity: 'error',
          message: `TypeScript ${pkg.version} is not in the supported matrix (5.9, 6, 7)`,
          fix: 'use TypeScript 5.9, 6 or 7',
        },
      ];
    }
    return [];
  } catch {
    return [
      {
        code: 'PD006',
        severity: 'error',
        message: 'typescript is not installed',
        fix: 'add typescript 5.9, 6 or 7',
      },
    ];
  }
}

function pd007(
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly DoctorFinding[] {
  const hasNever = sources.some((source) =>
    /validate\s*:\s*['"]never['"]/u.test(source.text),
  );
  const hasAdapter = sources.some((source) =>
    ADAPTER_SPECIFIERS.some((spec) => source.text.includes(spec)),
  );
  if (hasNever && hasAdapter) {
    return [
      {
        code: 'PD007',
        severity: 'warning',
        message:
          "policy sets validate: 'never' while an HTTP, MCP or agent adapter is imported",
        fix: "use validate: 'boundary' for untrusted input",
      },
    ];
  }
  return [];
}

function pd008(
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (!source.text.includes('permdock')) {
      continue;
    }
    if (
      /export\s+(?:const|function|class)\s+(?:dock|ability)\b/u.test(
        source.text,
      )
    ) {
      findings.push({
        code: 'PD008',
        severity: 'warning',
        message: `${source.file} exports a reserved name (dock or ability)`,
        fix: 'use createPermDock and permdock',
      });
    }
    if (/export\s+(?:const|function|type|interface)\s+\$/u.test(source.text)) {
      findings.push({
        code: 'PD008',
        severity: 'warning',
        message: `${source.file} exports a $ prefixed member`,
        fix: 'drop the $ prefix',
      });
    }
  }
  return findings;
}

function pd009(cwd: string): readonly DoctorFinding[] {
  const copies: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > 6 || !existsSync(dir)) {
      return;
    }
    const pkg = join(dir, 'node_modules/permdock/package.json');
    if (existsSync(pkg)) {
      copies.push(pkg);
    }
    if (!existsSync(join(dir, 'node_modules'))) {
      return;
    }
    for (const name of readdirSync(join(dir, 'node_modules'))) {
      if (name.startsWith('.')) {
        continue;
      }
      const nested = join(dir, 'node_modules', name);
      try {
        if (statSync(nested).isDirectory()) {
          walk(nested, depth + 1);
        }
      } catch {
        // ignore broken links
      }
    }
  }
  walk(cwd, 0);
  if (copies.length > 1) {
    return [
      {
        code: 'PD009',
        severity: 'error',
        message: `duplicate permdock copies: ${copies.map((item) => rel(cwd, dirname(dirname(item)))).join(', ')}`,
        fix: 'dedupe so only one permdock version is installed',
      },
    ];
  }
  return [];
}

function pd010(
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    for (const claim of UNTRUSTED_CLAIMS) {
      if (source.text.includes(claim) && /roles|tenant/u.test(source.text)) {
        findings.push({
          code: 'PD010',
          severity: 'error',
          message: `${source.file} reads roles or tenant from ${claim}`,
          fix: 'use a server-set claim or a MembershipSource',
        });
      }
    }
  }
  return findings;
}

function pd011(
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (
      /tenant['"]?\s*:\s*['"]hd['"]/u.test(source.text) ||
      (/accounts\.google\.com/u.test(source.text) && /tenant/.test(source.text))
    ) {
      findings.push({
        code: 'PD011',
        severity: 'warning',
        message: `${source.file} reads tenant from an optional issuer claim`,
        fix: 'compare the claim to onboarded tenants; do not default a tenant',
      });
    }
  }
  return findings;
}

function pd012(cwd: string, config: PermDockConfig): readonly DoctorFinding[] {
  const docs = config.openapi?.doc ?? [];
  const findings: DoctorFinding[] = [];
  for (const doc of docs) {
    const abs = resolve(cwd, doc);
    if (!existsSync(abs)) {
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    if (text.includes('"drafts"') && !text.includes('overlay')) {
      findings.push({
        code: 'PD012',
        severity: 'warning',
        message: `${doc} carries a draft pin the CLI no longer emits`,
        fix: 'regenerate with permdock openapi',
      });
    }
  }
  return findings;
}

function pd013(
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (/algorithms[\s\S]{0,120}EdDSA/u.test(source.text)) {
      findings.push({
        code: 'PD013',
        severity: 'warning',
        message: `${source.file} lists polymorphic EdDSA`,
        fix: 'write Ed25519',
      });
    }
    if (/algorithms[\s\S]{0,120}['"]none['"]/u.test(source.text)) {
      findings.push({
        code: 'PD013',
        severity: 'error',
        message: `${source.file} allows alg none`,
        fix: 'remove none and RSA1_5 from algorithms',
      });
    }
  }
  return findings;
}

function pd014(
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (/discovery:\s*['"]http:/u.test(source.text)) {
      findings.push({
        code: 'PD014',
        severity: 'error',
        message: `${source.file} uses a plain-HTTP discovery URL`,
        fix: 'use an https: issuer',
      });
    }
    if (/discovery\s*:/u.test(source.text) && /jwks\s*:/u.test(source.text)) {
      findings.push({
        code: 'PD014',
        severity: 'error',
        message: `${source.file} sets discovery together with jwks or issuer`,
        fix: 'use discovery alone, or jwks plus issuer',
      });
    }
    if (
      /jwks\s*:/u.test(source.text) &&
      !/issuer\s*:/u.test(source.text) &&
      !/discovery\s*:/u.test(source.text)
    ) {
      findings.push({
        code: 'PD014',
        severity: 'error',
        message: `${source.file} sets jwks without issuer`,
        fix: 'set issuer with jwks, or switch to discovery',
      });
    }
  }
  return findings;
}

function pd015(
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (/accept:\s*['"]id-token['"]/u.test(source.text)) {
      findings.push({
        code: 'PD015',
        severity: 'warning',
        message: `${source.file} accepts id-token on what looks like an API resolver`,
        fix: "leave accept as 'access-token' for API routes",
      });
    }
  }
  return findings;
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
