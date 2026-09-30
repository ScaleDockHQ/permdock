import type {
  DeviceFlowOptions,
  TerminalRuntime,
  TerminalStorageOptions,
  TokenSource,
  TokenSourceName,
} from './types.ts';

import { refreshCredential, runDeviceFlow } from './device.ts';
import { readCredentials, writeCredentials } from './storage.ts';

const JWT_PART = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export function looksLikeJwt(value: string): boolean {
  return JWT_PART.test(value);
}

export function warnJwtInArgv(
  argv: readonly string[],
  write: (text: string) => void,
): void {
  for (const arg of argv) {
    if (looksLikeJwt(arg)) {
      write(
        'warning: a JWT-shaped value was found in argv; tokens must not be passed as flags\n',
      );
      return;
    }
  }
}

export function profileFromArgv(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--as');
  if (index === -1) {
    return undefined;
  }
  const next = argv[index + 1];
  return next === undefined || next.startsWith('-') ? undefined : next;
}

function sourceName(source: TokenSource): TokenSourceName {
  if (typeof source === 'string') {
    return source;
  }
  if ('source' in source) {
    return source.source;
  }
  return 'env';
}

function envName(source: TokenSource, fallback: string): string {
  if (typeof source === 'string') {
    return fallback;
  }
  return source.env ?? fallback;
}

async function fromCiOidc(
  runtime: TerminalRuntime,
  source: TokenSource,
): Promise<string | null> {
  const env = runtime.env ?? process.env;
  const fetchImpl = runtime.fetch ?? fetch;
  const named = typeof source === 'string' ? undefined : source.env;
  const audience =
    typeof source === 'object' && 'audience' in source
      ? source.audience
      : undefined;
  if (named !== undefined) {
    const value = env[named];
    return typeof value === 'string' && value !== '' ? value : null;
  }
  if (typeof env['CI_JOB_JWT_V2'] === 'string' && env['CI_JOB_JWT_V2'] !== '') {
    return env['CI_JOB_JWT_V2'];
  }
  if (
    typeof env['ACTIONS_ID_TOKEN_REQUEST_URL'] === 'string' &&
    typeof env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] === 'string'
  ) {
    try {
      const url = new URL(env['ACTIONS_ID_TOKEN_REQUEST_URL']);
      if (audience !== undefined) {
        url.searchParams.set('audience', audience);
      }
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}`,
        },
      });
      const body: unknown = await response.json();
      if (
        body !== null &&
        typeof body === 'object' &&
        'value' in body &&
        typeof body.value === 'string'
      ) {
        return body.value;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function resolveToken(
  sources: readonly TokenSource[],
  options: {
    readonly profile: string;
    readonly storage?: TerminalStorageOptions;
    readonly device?: DeviceFlowOptions;
    readonly runtime: TerminalRuntime;
    readonly write: (text: string) => void;
    readonly force?: TokenSourceName;
  },
): Promise<string | null> {
  const walk = options.force === undefined ? sources : [options.force];
  const now =
    options.runtime.now ?? ((): number => Math.floor(Date.now() / 1000));
  for (const source of walk) {
    const name = sourceName(source);
    switch (name) {
      case 'env': {
        const key = envName(source, 'PERMDOCK_TOKEN');
        const value = (options.runtime.env ?? process.env)[key];
        if (typeof value === 'string' && value !== '') {
          return value;
        }
        break;
      }
      case 'keychain': {
        if (options.storage === undefined) {
          break;
        }
        const stored = readCredentials(
          options.storage,
          options.profile,
          options.runtime,
        );
        if (stored === null) {
          break;
        }
        if (stored.expires_at !== undefined && stored.expires_at <= now()) {
          if (options.device !== undefined) {
            const refreshed = await refreshCredential(
              options.device,
              stored,
              options.runtime,
            );
            if (refreshed !== null) {
              writeCredentials(
                options.storage,
                options.profile,
                refreshed,
                options.runtime,
              );
              return refreshed.access_token;
            }
          }
          break;
        }
        return stored.access_token;
      }
      case 'ci-oidc': {
        const oidc = await fromCiOidc(options.runtime, source);
        if (oidc !== null) {
          return oidc;
        }
        break;
      }
      case 'device': {
        if (options.device === undefined) {
          break;
        }
        const credential = await runDeviceFlow(
          options.device,
          options.runtime,
          options.write,
        );
        if (credential === null) {
          break;
        }
        if (options.storage !== undefined) {
          writeCredentials(
            options.storage,
            options.profile,
            credential,
            options.runtime,
          );
        }
        return credential.access_token;
      }
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  }
  return null;
}
