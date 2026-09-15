import type { ScimPage } from './types.ts';

import { compact } from '../core/compact.ts';

const RESOURCES = new Set([
  'Users',
  'Groups',
  'ServiceProviderConfig',
  'ResourceTypes',
  'Schemas',
]);

export type ScimRoute =
  | { readonly kind: 'Users'; readonly id?: string }
  | { readonly kind: 'Groups'; readonly id?: string }
  | { readonly kind: 'ServiceProviderConfig' }
  | { readonly kind: 'ResourceTypes' }
  | { readonly kind: 'Schemas'; readonly id?: string };

export function tenantFromPath(request: Request): string {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part ?? ''));
  if (index <= 0) {
    return '';
  }
  const prev = parts[index - 1] ?? '';
  if (prev === 'v2' || prev === 'scim') {
    return '';
  }
  return prev;
}

export function parseRoute(url: URL): ScimRoute | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part ?? ''));
  if (index === -1) {
    return undefined;
  }
  const kind = parts[index];
  const id = parts[index + 1];
  if (kind === undefined) {
    return undefined;
  }
  switch (kind) {
    case 'Users':
      return compact<ScimRoute>({ kind: 'Users', id });
    case 'Groups':
      return compact<ScimRoute>({ kind: 'Groups', id });
    case 'ServiceProviderConfig':
      return { kind: 'ServiceProviderConfig' };
    case 'ResourceTypes':
      return { kind: 'ResourceTypes' };
    case 'Schemas':
      return compact<ScimRoute>({ kind: 'Schemas', id });
    default:
      return undefined;
  }
}

function prefixOf(request: Request): {
  readonly origin: string;
  readonly prefix: readonly string[];
} {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => RESOURCES.has(part ?? ''));
  return {
    origin: url.origin,
    prefix: index === -1 ? parts : parts.slice(0, index),
  };
}

export function audienceOf(request: Request, configured?: string): string {
  if (configured !== undefined) {
    return configured;
  }
  const { origin, prefix } = prefixOf(request);
  return `${origin}/${prefix.join('/')}`;
}

export function locationOf(
  request: Request,
  kind: 'Users' | 'Groups',
  id: string,
): string {
  const { origin, prefix } = prefixOf(request);
  return `${origin}/${[...prefix, kind, id].join('/')}`;
}

export function pageFrom(url: URL): ScimPage {
  const startIndex = url.searchParams.get('startIndex');
  const count = url.searchParams.get('count');
  const cursor = url.searchParams.get('cursor');
  return compact<ScimPage>({
    startIndex:
      startIndex === null ? undefined : Math.trunc(Number(startIndex)),
    count: count === null ? undefined : Math.trunc(Number(count)),
    cursor: cursor ?? undefined,
  });
}
