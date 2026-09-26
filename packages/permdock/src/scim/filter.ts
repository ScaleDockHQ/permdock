import type { DirectoryGroup, DirectoryUser, ScimFilter } from './types.ts';

const COMPARE = new Set(['eq', 'ne', 'co', 'sw']);

function skipSpace(input: string, index: number): number {
  let cursor = index;
  while (cursor < input.length && input[cursor] === ' ') {
    cursor += 1;
  }
  return cursor;
}

function readIdent(
  input: string,
  index: number,
): { readonly value: string; readonly next: number } | undefined {
  const start = skipSpace(input, index);
  if (!/[A-Za-z]/u.test(input[start] ?? '')) {
    return undefined;
  }
  let cursor = start;
  while (cursor < input.length && /[A-Za-z0-9._]/u.test(input[cursor] ?? '')) {
    cursor += 1;
  }
  return { value: input.slice(start, cursor), next: cursor };
}

function readString(
  input: string,
  index: number,
): { readonly value: string; readonly next: number } | undefined {
  const start = skipSpace(input, index);
  if (input[start] !== '"') {
    return undefined;
  }
  let cursor = start + 1;
  let value = '';
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === '\\') {
      value += input[cursor + 1] ?? '';
      cursor += 2;
      continue;
    }
    if (char === '"') {
      return { value, next: cursor + 1 };
    }
    value += char;
    cursor += 1;
  }
  return undefined;
}

function readLiteral(
  input: string,
  index: number,
): { readonly value: string | boolean; readonly next: number } | undefined {
  const quoted = readString(input, index);
  if (quoted !== undefined) {
    return quoted;
  }
  const ident = readIdent(input, index);
  if (ident === undefined) {
    return undefined;
  }
  if (ident.value.toLowerCase() === 'true') {
    return { value: true, next: ident.next };
  }
  if (ident.value.toLowerCase() === 'false') {
    return { value: false, next: ident.next };
  }
  return { value: ident.value, next: ident.next };
}

function parsePrimary(
  input: string,
  index: number,
): { readonly filter: ScimFilter; readonly next: number } | undefined {
  const start = skipSpace(input, index);
  if (input[start] === '(') {
    const inner = parseOr(input, start + 1);
    if (inner === undefined) {
      return undefined;
    }
    const close = skipSpace(input, inner.next);
    if (input[close] !== ')') {
      return undefined;
    }
    return { filter: inner.filter, next: close + 1 };
  }
  const attribute = readIdent(input, start);
  if (attribute === undefined) {
    return undefined;
  }
  const opToken = readIdent(input, attribute.next);
  if (opToken === undefined) {
    return undefined;
  }
  const op = opToken.value.toLowerCase();
  if (op === 'pr') {
    return {
      filter: { op: 'pr', attribute: attribute.value },
      next: opToken.next,
    };
  }
  if (!COMPARE.has(op)) {
    return undefined;
  }
  const value = readLiteral(input, opToken.next);
  if (value === undefined) {
    return undefined;
  }
  return {
    filter: {
      op: op as 'eq' | 'ne' | 'co' | 'sw',
      attribute: attribute.value,
      value: value.value,
    },
    next: value.next,
  };
}

function parseAnd(
  input: string,
  index: number,
): { readonly filter: ScimFilter; readonly next: number } | undefined {
  const first = parsePrimary(input, index);
  if (first === undefined) {
    return undefined;
  }
  const filters: ScimFilter[] = [first.filter];
  let cursor = first.next;
  for (;;) {
    const nextOp = readIdent(input, cursor);
    if (nextOp === undefined || nextOp.value.toLowerCase() !== 'and') {
      break;
    }
    const next = parsePrimary(input, nextOp.next);
    if (next === undefined) {
      return undefined;
    }
    filters.push(next.filter);
    cursor = next.next;
  }
  if (filters.length === 1) {
    return { filter: first.filter, next: cursor };
  }
  return { filter: { op: 'and', filters }, next: cursor };
}

function parseOr(
  input: string,
  index: number,
): { readonly filter: ScimFilter; readonly next: number } | undefined {
  const first = parseAnd(input, index);
  if (first === undefined) {
    return undefined;
  }
  const filters: ScimFilter[] = [first.filter];
  let cursor = first.next;
  for (;;) {
    const nextOp = readIdent(input, cursor);
    if (nextOp === undefined || nextOp.value.toLowerCase() !== 'or') {
      break;
    }
    const next = parseAnd(input, nextOp.next);
    if (next === undefined) {
      return undefined;
    }
    filters.push(next.filter);
    cursor = next.next;
  }
  if (filters.length === 1) {
    return { filter: first.filter, next: cursor };
  }
  return { filter: { op: 'or', filters }, next: cursor };
}

export function parseScimFilter(input: string): ScimFilter | undefined {
  const trimmed = input.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = parseOr(trimmed, 0);
  if (parsed === undefined) {
    return undefined;
  }
  if (skipSpace(trimmed, parsed.next) !== trimmed.length) {
    return undefined;
  }
  return parsed.filter;
}

function readAttribute(
  target: Record<string, unknown>,
  attribute: string,
): unknown {
  if (attribute === 'members.value') {
    const members = target.members;
    if (!Array.isArray(members)) {
      return undefined;
    }
    return members.map((member) => {
      if (member !== null && typeof member === 'object' && 'value' in member) {
        return (member as { value?: unknown }).value;
      }
      return undefined;
    });
  }
  const parts = attribute.split('.');
  let current: unknown = target;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asString(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

function matchCompare(
  actual: unknown,
  op: 'eq' | 'ne' | 'co' | 'sw',
  expected: string | boolean,
): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => matchCompare(item, op, expected));
  }
  if (actual === undefined || actual === null) {
    return op === 'ne';
  }
  if (typeof expected === 'boolean' || typeof actual === 'boolean') {
    const left = asString(actual).toLowerCase();
    const right = asString(expected).toLowerCase();
    return op === 'eq' ? left === right : op === 'ne' ? left !== right : false;
  }
  const left = asString(actual);
  const right = asString(expected);
  switch (op) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'co':
      return left.includes(right);
    case 'sw':
      return left.startsWith(right);
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

/** RFC 7644 §3.4.2.2: `pr` needs a non-empty value; a multi-valued one needs an item. */
function present(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(present);
  }
  return value !== undefined && value !== null && value !== '';
}

export function matchFilter(
  target: DirectoryUser | DirectoryGroup | Record<string, unknown>,
  filter: ScimFilter | undefined,
): boolean {
  if (filter === undefined) {
    return true;
  }
  const record = target as Record<string, unknown>;
  switch (filter.op) {
    case 'and':
      return filter.filters.every((item) => matchFilter(target, item));
    case 'or':
      return filter.filters.some((item) => matchFilter(target, item));
    case 'pr':
      return present(readAttribute(record, filter.attribute));
    case 'eq':
    case 'ne':
    case 'co':
    case 'sw':
      return matchCompare(
        readAttribute(record, filter.attribute),
        filter.op,
        filter.value,
      );
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

const SUPPORTED_FILTER_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'userName',
  'externalId',
  'active',
  'displayName',
  'members.value',
]);

export function filterSupported(filter: ScimFilter): boolean {
  switch (filter.op) {
    case 'and':
    case 'or':
      return filter.filters.every(filterSupported);
    case 'pr':
    case 'eq':
    case 'ne':
    case 'co':
    case 'sw':
      return SUPPORTED_FILTER_ATTRIBUTES.has(filter.attribute);
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}
