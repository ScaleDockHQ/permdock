import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { StoredCredential, TerminalRuntime } from './types.ts';

import { compact } from '../core/compact.ts';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const GROUP_OR_WORLD = 0o077;

export function credentialsPath(
  service: string,
  runtime: TerminalRuntime,
): string {
  if (runtime.configDir !== undefined) {
    return path.join(runtime.configDir, 'credentials.json');
  }
  const home = runtime.homedir ?? homedir;
  const env = runtime.env ?? process.env;
  const platform = runtime.platform ?? process.platform;
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home(), 'AppData', 'Roaming');
    return path.join(appData, service, 'credentials.json');
  }
  const xdg = env.XDG_CONFIG_HOME ?? path.join(home(), '.config');
  return path.join(xdg, service, 'credentials.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCredential(value: unknown): StoredCredential | null {
  if (!isRecord(value) || typeof value.access_token !== 'string') {
    return null;
  }
  return compact<StoredCredential>({
    access_token: value.access_token,
    refresh_token:
      typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
    expires_at:
      typeof value.expires_at === 'number' ? value.expires_at : undefined,
    token_type:
      typeof value.token_type === 'string' ? value.token_type : undefined,
  });
}

export function readCredentials(
  service: string,
  profile: string,
  runtime: TerminalRuntime,
): StoredCredential | null {
  const file = credentialsPath(service, runtime);
  let raw: string;
  try {
    const stat = statSync(file);
    const platform = runtime.platform ?? process.platform;
    if (platform !== 'win32' && (stat.mode & GROUP_OR_WORLD) !== 0) {
      return null;
    }
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
      return null;
    }
    return parseCredential(parsed.profiles[profile]);
  } catch {
    return null;
  }
}

export function writeCredentials(
  service: string,
  profile: string,
  credential: StoredCredential,
  runtime: TerminalRuntime,
): void {
  const file = credentialsPath(service, runtime);
  mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  let profiles: Record<string, StoredCredential> = {};
  try {
    const existing: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(existing) && isRecord(existing.profiles)) {
      profiles = existing.profiles as Record<string, StoredCredential>;
    }
  } catch {
    profiles = {};
  }
  profiles[profile] = credential;
  writeFileSync(file, `${JSON.stringify({ profiles }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: FILE_MODE,
  });
}

export function deleteCredentials(
  service: string,
  profile: string,
  runtime: TerminalRuntime,
): void {
  const file = credentialsPath(service, runtime);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
    return;
  }
  const profiles: Record<string, unknown> = {};
  for (const key of Object.keys(parsed.profiles)) {
    if (key !== profile) {
      profiles[key] = parsed.profiles[key];
    }
  }
  if (Object.keys(profiles).length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // ignore
    }
    return;
  }
  writeFileSync(file, `${JSON.stringify({ profiles }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: FILE_MODE,
  });
}
