import type { ProblemDetails } from '../core/errors.ts';
import type { Actor, JsonWebKeyLike } from '../core/subject.ts';

import { compact } from '../core/compact.ts';
import { PROBLEM_BASE, problemResponse } from './problem.ts';

const DEFAULT_MAX_AGE = 300;
const FUTURE_SKEW = 60;
const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';

export type WebBotAuthJwk = JsonWebKeyLike & {
  readonly kid?: string;
  readonly crv?: string;
};

export type WebBotAuthKeyLookup = (input: {
  readonly request: Request;
  readonly keyid: string;
  readonly agent: string | undefined;
}) => WebBotAuthJwk | undefined | Promise<WebBotAuthJwk | undefined>;

export type WebBotAuthKeys = {
  readonly lookup: WebBotAuthKeyLookup;
};

export type WebBotAuthOptions = {
  readonly verify?: boolean;
  readonly keys: WebBotAuthKeys | WebBotAuthKeyLookup;
  readonly required?: boolean;
  readonly maxAge?: number;
};

export type DiscoverViaSignatureAgentOptions = {
  readonly allow: readonly string[];
  readonly fetch?: typeof fetch;
};

export class InvalidSignatureError extends Error {
  public override readonly name = 'InvalidSignatureError' as const;
  public readonly response: Response;

  public constructor(response: Response) {
    super('Web Bot Auth signature was rejected');
    this.response = response;
  }
}

export function invalidSignatureResponse(error: unknown): Response | undefined {
  return error instanceof InvalidSignatureError ? error.response : undefined;
}

export function invalidSignatureProblem(
  detail: string,
  base?: string,
): Response {
  const prefix = base ?? PROBLEM_BASE;
  return problemResponse(
    compact<ProblemDetails>({
      type: `${prefix}/invalid-signature`,
      title: 'Invalid signature',
      status: 403,
      detail,
    }),
  );
}

export function discoverViaSignatureAgent(
  options: DiscoverViaSignatureAgentOptions,
): WebBotAuthKeys {
  const fetchFn = options.fetch ?? fetch;
  const allow = new Set(options.allow);
  const cache = new Map<string, Promise<readonly WebBotAuthJwk[]>>();

  const lookup: WebBotAuthKeyLookup = async ({
    keyid,
    agent,
  }): Promise<WebBotAuthJwk | undefined> => {
    if (agent === undefined) {
      return undefined;
    }
    let url: URL;
    try {
      url = new URL(agent);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' || !allow.has(url.hostname)) {
      return undefined;
    }
    const directoryUrl =
      url.pathname === '/' || url.pathname === ''
        ? `${url.origin}${DIRECTORY_PATH}`
        : agent;
    let pending = cache.get(directoryUrl);
    if (pending === undefined) {
      pending = loadDirectory(fetchFn, directoryUrl);
      cache.set(directoryUrl, pending);
    }
    let keys: readonly WebBotAuthJwk[];
    try {
      keys = await pending;
    } catch {
      cache.delete(directoryUrl);
      return undefined;
    }
    return keys.find((key) => key.kid === keyid);
  };

  return { lookup };
}

export async function verifyWebBotAuth(
  request: Request,
  options: WebBotAuthOptions | undefined,
  problemBase?: string,
): Promise<Actor | undefined> {
  if (options === undefined || options.verify === false) {
    return undefined;
  }
  const signatureInput = request.headers.get('Signature-Input');
  if (signatureInput === null) {
    if (options.required === true) {
      throw new InvalidSignatureError(
        invalidSignatureProblem('Signature-Input is required', problemBase),
      );
    }
    return undefined;
  }
  const parsed = parseSignatureInput(signatureInput);
  const signatureHeader = request.headers.get('Signature');
  if (parsed === undefined || signatureHeader === null) {
    throw reject(problemBase, 'Signature-Input could not be parsed');
  }
  const signature = parseSignature(signatureHeader, parsed.label);
  if (signature === undefined) {
    throw reject(problemBase, 'Signature could not be parsed');
  }
  const now = Math.floor(Date.now() / 1000);
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
  if (typeof parsed.created !== 'number') {
    throw reject(problemBase, 'Signature-Input created is required');
  }
  if (parsed.created > now + FUTURE_SKEW) {
    throw reject(problemBase, 'Signature-Input created is in the future');
  }
  if (now - parsed.created > maxAge) {
    throw reject(problemBase, 'Signature-Input created is too old');
  }
  if (typeof parsed.expires === 'number' && parsed.expires < now) {
    throw reject(problemBase, 'Signature-Input expires is in the past');
  }
  if (parsed.keyid === undefined) {
    throw reject(problemBase, 'Signature-Input keyid is required');
  }
  const agent = parseSignatureAgent(
    request.headers.get('Signature-Agent'),
    parsed.label,
  );
  const lookup =
    typeof options.keys === 'function' ? options.keys : options.keys.lookup;
  let key: WebBotAuthJwk | undefined;
  try {
    key = await lookup({ request, keyid: parsed.keyid, agent });
  } catch {
    throw reject(problemBase, 'Web Bot Auth key lookup failed');
  }
  if (key === undefined) {
    throw reject(problemBase, 'Web Bot Auth key was not found');
  }
  const base = signatureBase(request, parsed);
  if (base === undefined) {
    throw reject(problemBase, 'signed components could not be covered');
  }
  const alg = parsed.alg ?? algorithmFromJwk(key);
  if (alg === undefined) {
    throw reject(problemBase, 'signature algorithm is not supported');
  }
  const ok = await verifyBytes(key, alg, signature, base);
  if (!ok) {
    throw reject(problemBase, 'HTTP Message Signature did not verify');
  }
  return Object.freeze({ id: parsed.keyid, kind: 'web-bot-auth' });
}

function reject(
  base: string | undefined,
  detail: string,
): InvalidSignatureError {
  return new InvalidSignatureError(invalidSignatureProblem(detail, base));
}

type ParsedSignatureInput = {
  readonly label: string;
  readonly components: readonly string[];
  readonly created?: number;
  readonly expires?: number;
  readonly keyid?: string;
  readonly alg?: string;
  readonly innerListAndParams: string;
};

function parseSignatureInput(header: string): ParsedSignatureInput | undefined {
  const member = firstDictionaryMember(header);
  if (member === undefined) {
    return undefined;
  }
  const inner = parseInnerListAndParams(member.value);
  if (inner === undefined) {
    return undefined;
  }
  return compact<ParsedSignatureInput>({
    label: member.key,
    components: inner.components,
    created: inner.created,
    expires: inner.expires,
    keyid: inner.keyid,
    alg: inner.alg,
    innerListAndParams: member.value.trim(),
  });
}

function parseSignature(header: string, label: string): Uint8Array | undefined {
  const member = dictionaryMember(header, label);
  if (member === undefined) {
    return undefined;
  }
  return decodeSfBytes(member);
}

function parseSignatureAgent(
  header: string | null,
  label: string,
): string | undefined {
  if (header === null) {
    return undefined;
  }
  const trimmed = header.trim();
  if (trimmed.startsWith('"')) {
    return unquote(trimmed);
  }
  const member =
    dictionaryMember(trimmed, label) ?? firstDictionaryMember(trimmed)?.value;
  if (member === undefined) {
    return undefined;
  }
  return unquote(member.trim());
}

function firstDictionaryMember(
  header: string,
): { readonly key: string; readonly value: string } | undefined {
  const parts = splitTopLevel(header, ',');
  const first = parts[0];
  if (first === undefined) {
    return undefined;
  }
  const eq = first.indexOf('=');
  if (eq <= 0) {
    return undefined;
  }
  return { key: first.slice(0, eq).trim(), value: first.slice(eq + 1) };
}

function dictionaryMember(header: string, label: string): string | undefined {
  for (const part of splitTopLevel(header, ',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    if (part.slice(0, eq).trim() === label) {
      return part.slice(eq + 1);
    }
  }
  return undefined;
}

function parseInnerListAndParams(value: string):
  | {
      readonly components: readonly string[];
      readonly created?: number;
      readonly expires?: number;
      readonly keyid?: string;
      readonly alg?: string;
    }
  | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('(')) {
    return undefined;
  }
  const close = trimmed.indexOf(')');
  if (close < 0) {
    return undefined;
  }
  const components = parseQuotedList(trimmed.slice(1, close));
  if (components === undefined) {
    return undefined;
  }
  const params = parseParams(trimmed.slice(close + 1));
  return compact({
    components,
    created: asUnix(params.created),
    expires: asUnix(params.expires),
    keyid: typeof params.keyid === 'string' ? params.keyid : undefined,
    alg: typeof params.alg === 'string' ? params.alg : undefined,
  });
}

function parseQuotedList(inner: string): readonly string[] | undefined {
  const items: string[] = [];
  const parts = splitTopLevel(inner, ' ');
  for (const part of parts) {
    const next = part.trim();
    if (next === '') {
      continue;
    }
    if (!next.startsWith('"') || !next.endsWith('"')) {
      return undefined;
    }
    const item = unquote(next);
    if (item === undefined) {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

function parseParams(
  suffix: string,
): Readonly<Record<string, string | number>> {
  const params: Record<string, string | number> = {};
  for (const part of suffix.split(';')) {
    const next = part.trim();
    if (next === '') {
      continue;
    }
    const eq = next.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = next.slice(0, eq);
    const raw = next.slice(eq + 1);
    if (raw.startsWith('"')) {
      const quoted = unquote(raw);
      if (quoted !== undefined) {
        params[name] = quoted;
      }
      continue;
    }
    const numeric = Number(raw);
    params[name] = Number.isFinite(numeric) ? numeric : raw;
  }
  return params;
}

function asUnix(value: string | number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function signatureBase(
  request: Request,
  parsed: ParsedSignatureInput,
): Uint8Array | undefined {
  const lines: string[] = [];
  for (const component of parsed.components) {
    const value = componentValue(request, component);
    if (value === undefined) {
      return undefined;
    }
    lines.push(`"${component}": ${value}`);
  }
  lines.push(`"@signature-params": ${parsed.innerListAndParams}`);
  return new TextEncoder().encode(lines.join('\n'));
}

function componentValue(
  request: Request,
  component: string,
): string | undefined {
  if (component.startsWith('@')) {
    const url = new URL(request.url);
    switch (component) {
      case '@method':
        return request.method;
      case '@authority':
        return url.host;
      case '@path':
        return url.pathname;
      case '@query':
        return url.search;
      case '@target-uri':
        return url.href;
      case '@scheme':
        return url.protocol.replace(':', '');
      case '@request-target':
        return `${url.pathname}${url.search}`;
      default:
        return undefined;
    }
  }
  return request.headers.get(component) ?? undefined;
}

function algorithmFromJwk(key: WebBotAuthJwk): string | undefined {
  if (key.kty === 'OKP' && key.crv === 'Ed25519') {
    return 'ed25519';
  }
  if (key.kty === 'EC' && key.crv === 'P-256') {
    return 'ecdsa-p256-sha256';
  }
  return undefined;
}

async function verifyBytes(
  key: WebBotAuthJwk,
  alg: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    if (alg === 'ed25519') {
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        key as never,
        'Ed25519',
        false,
        ['verify'],
      );
      return await crypto.subtle.verify('Ed25519', cryptoKey, signature, data);
    }
    if (alg === 'ecdsa-p256-sha256') {
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        key as never,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey,
        signature,
        data,
      );
    }
    return false;
  } catch {
    return false;
  }
}

async function loadDirectory(
  fetchFn: typeof fetch,
  directoryUrl: string,
): Promise<readonly WebBotAuthJwk[]> {
  const response = await fetchFn(directoryUrl, {
    headers: {
      accept:
        'application/http-message-signatures-directory+json, application/json',
    },
  });
  if (!response.ok) {
    throw new TypeError('directory fetch failed');
  }
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }
  const keys = (body as { readonly keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    return [];
  }
  return keys.filter(isWebBotAuthJwk);
}

function isWebBotAuthJwk(value: unknown): value is WebBotAuthJwk {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function splitTopLevel(input: string, separator: string): readonly string[] {
  const parts: string[] = [];
  let current = '';
  let quotes = false;
  let depth = 0;
  for (const char of input) {
    if (char === '"' && depth === 0) {
      quotes = !quotes;
      current += char;
      continue;
    }
    if (!quotes && char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (!quotes && char === ')' && depth > 0) {
      depth -= 1;
      current += char;
      continue;
    }
    if (!quotes && depth === 0 && char === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') {
    parts.push(current);
  }
  return parts;
}

function unquote(value: string): string | undefined {
  if (!value.startsWith('"')) {
    return value;
  }
  if (!value.endsWith('"') || value.length < 2) {
    return undefined;
  }
  return value.slice(1, -1).replaceAll('\\"', '"');
}

function decodeSfBytes(value: string): Uint8Array | undefined {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith(':') ||
    !trimmed.endsWith(':') ||
    trimmed.length < 2
  ) {
    return undefined;
  }
  try {
    const binary = atob(trimmed.slice(1, -1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.codePointAt(index) ?? 0;
    }
    return bytes;
  } catch {
    return undefined;
  }
}
