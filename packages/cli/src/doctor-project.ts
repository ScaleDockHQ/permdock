import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import type { DoctorFinding } from './doctor-types.ts';
import type { PermDockConfig } from './types.ts';

import { rel } from './files.ts';

export function pd005(cwd: string): readonly DoctorFinding[] {
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

export function pd006(cwd: string): readonly DoctorFinding[] {
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

export function pd009(cwd: string): readonly DoctorFinding[] {
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

export function pd012(
  cwd: string,
  config: PermDockConfig,
): readonly DoctorFinding[] {
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
