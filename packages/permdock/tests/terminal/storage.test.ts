import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { KeyringEntry } from '../../src/terminal/types.ts';

import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from '../../src/terminal/storage.ts';

const vault = new Map<string, string>();

class FakeEntry implements KeyringEntry {
  private readonly key: string;
  public constructor(service: string, account: string) {
    this.key = `${service}/${account}`;
  }
  public getPassword(): string | null {
    return vault.get(this.key) ?? null;
  }
  public setPassword(password: string): void {
    vault.set(this.key, password);
  }
  public deletePassword(): boolean {
    return vault.delete(this.key);
  }
}

class BrokenEntry implements KeyringEntry {
  private readonly reason = 'no secret service';
  public getPassword(): string {
    throw new Error(this.reason);
  }
  public setPassword(): void {
    throw new Error(this.reason);
  }
  public deletePassword(): boolean {
    throw new Error(this.reason);
  }
}

const dirs: string[] = [];

function runtime() {
  const dir = mkdtempSync(path.join(tmpdir(), 'permdock-keyring-'));
  dirs.push(dir);
  return { configDir: dir };
}

afterEach(() => {
  vault.clear();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const credential = { access_token: 'at', refresh_token: 'rt', expires_at: 9 };

describe('terminal credential storage', () => {
  it('stores tokens in the keychain when a keyring is given', () => {
    const rt = runtime();
    const storage = { service: 'acme-cli', keyring: FakeEntry };
    writeCredentials(storage, 'default', credential, rt);
    expect(vault.has('acme-cli/default')).toBe(true);
    expect(existsSync(credentialsPath('acme-cli', rt))).toBe(false);
    expect(readCredentials(storage, 'default', rt)).toEqual(credential);
    deleteCredentials(storage, 'default', rt);
    expect(vault.size).toBe(0);
    expect(readCredentials(storage, 'default', rt)).toBeNull();
  });

  it('falls back to the mode-0600 file when the keychain throws', () => {
    const rt = runtime();
    const storage = { service: 'acme-cli', keyring: BrokenEntry };
    writeCredentials(storage, 'default', credential, rt);
    expect(existsSync(credentialsPath('acme-cli', rt))).toBe(true);
    expect(readCredentials(storage, 'default', rt)).toEqual(credential);
    deleteCredentials(storage, 'default', rt);
    expect(existsSync(credentialsPath('acme-cli', rt))).toBe(false);
  });

  it('reads a file written before the keyring was configured', () => {
    const rt = runtime();
    writeCredentials({ service: 'acme-cli' }, 'default', credential, rt);
    expect(
      readCredentials(
        { service: 'acme-cli', keyring: FakeEntry },
        'default',
        rt,
      ),
    ).toEqual(credential);
  });
});
