import { isReadonlyArray } from '../core/lists.ts';
export type DecodedHeader = {
  readonly alg?: string;
  readonly kid?: string;
  readonly typ?: string;
  readonly cty?: string;
  readonly enc?: string;
  readonly zip?: string;
  readonly crit?: readonly string[];
  readonly [key: string]: unknown;
};

export function compactParts(token: string): readonly string[] {
  return token.split('.');
}

export function isJwe(token: string): boolean {
  return compactParts(token).length === 5;
}

export function decodeHeader(token: string): DecodedHeader | undefined {
  const [encoded] = compactParts(token);
  if (encoded === undefined || encoded.length === 0) {
    return undefined;
  }
  try {
    const padded = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const pad =
      padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = atob(`${padded}${pad}`);
    const value: unknown = JSON.parse(json);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as DecodedHeader;
  } catch {
    return undefined;
  }
}

export function unknownCrit(header: DecodedHeader): boolean {
  const crit = header.crit;
  if (crit === undefined) {
    return false;
  }
  if (!isReadonlyArray(crit)) {
    return true;
  }
  const understood = new Set(['alg', 'kid', 'typ', 'cty', 'enc']);
  return crit.some((name) => typeof name !== 'string' || !understood.has(name));
}

export function normalizeTyp(typ: string | undefined): string | undefined {
  if (typ === undefined) {
    return undefined;
  }
  const lower = typ.toLowerCase();
  return lower.startsWith('application/')
    ? lower.slice('application/'.length)
    : lower;
}
