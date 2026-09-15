import type { DoctorFinding, DoctorSource } from './doctor-types.ts';

const SERVER_SPECIFIERS = [
  'permdock/server',
  'permdock/next',
  'permdock/hono',
  'permdock/mcp',
  'permdock/approvals',
  'permdock/jwt',
  'permdock/supabase',
  'permdock/ssf',
  'permdock/better-auth',
  'permdock/clerk',
  'permdock/convex',
  'permdock/pdp',
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

export function pd001(
  sources: readonly DoctorSource[],
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

export function pd007(
  sources: readonly DoctorSource[],
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

export function pd008(
  sources: readonly DoctorSource[],
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

export function pd010(
  sources: readonly DoctorSource[],
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

export function pd011(
  sources: readonly DoctorSource[],
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

export function pd013(
  sources: readonly DoctorSource[],
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

export function pd014(
  sources: readonly DoctorSource[],
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

export function pd015(
  sources: readonly DoctorSource[],
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
