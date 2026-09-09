import type { Policy } from '../core/policy.ts';
import type { Principal } from '../core/subject.ts';
import type { SsfAdapter, SsfOptions } from './types.ts';

import { compact } from '../core/compact.ts';
import { joseTokenVerifier } from '../jwt/verifier.ts';
import { createReceiver } from './receiver.ts';
import { memoryReplayStore } from './replay.ts';

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: SsfOptions,
): SsfAdapter {
  void policy;
  if (typeof options.subject !== 'function') {
    throw new TypeError('PermDock: permdock/ssf requires subject.');
  }
  if (options.audience === undefined) {
    throw new TypeError('PermDock: permdock/ssf requires audience.');
  }
  if (
    options.verifier === undefined &&
    options.jwks === undefined &&
    options.discovery === undefined
  ) {
    throw new TypeError(
      'PermDock: permdock/ssf requires verifier, jwks, or discovery.',
    );
  }
  if (options.issuer === undefined && options.discovery === undefined) {
    throw new TypeError('PermDock: permdock/ssf requires issuer or discovery.');
  }
  const jwks =
    typeof options.jwks === 'string' ? new URL(options.jwks) : options.jwks;
  const verifier =
    options.verifier ??
    joseTokenVerifier(
      compact({
        jwks,
        discovery: options.discovery,
        issuer: options.issuer,
        audience: options.audience,
        clockTolerance: options.clockTolerance,
      }),
    );
  return {
    receiver: createReceiver(
      compact({
        verifier,
        issuer: options.issuer,
        audience: options.audience,
        subject: options.subject,
        onEvent: options.onEvent ?? {},
        replay: options.replay ?? memoryReplayStore(),
        clockTolerance: options.clockTolerance,
      }),
    ),
  };
}
