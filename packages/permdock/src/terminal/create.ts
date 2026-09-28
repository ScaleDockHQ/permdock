import { createInterface } from 'node:readline';

import type { Decision } from '../core/decision.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Actor, Delegation, Principal } from '../core/subject.ts';
import type {
  CommandEntry,
  FilterCommandsOptions,
  FormatOptions,
  PermDockResolveOptions,
  ProtectContext,
  TerminalActor,
  TerminalPermDock,
  TerminalPermDockOptions,
  TerminalRuntime,
  TokenContext,
  TokenHelper,
  TokenSource,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { isSubject } from '../core/subject.ts';
import { revokeCredential } from './device.ts';
import { defaultExit, EX_NOPERM } from './exit.ts';
import { filterCommandEntries } from './filter.ts';
import { exitCode, formatDecision } from './format.ts';
import { deleteCredentials, readCredentials } from './storage.ts';
import { profileFromArgv, resolveToken, warnJwtInArgv } from './token.ts';

function writeOf(options: TerminalPermDockOptions): (text: string) => void {
  return (
    options.runtime?.write ??
    ((text: string): void => {
      process.stderr.write(text);
    })
  );
}

function argvOf(options: TerminalPermDockOptions): readonly string[] {
  return options.runtime?.argv ?? process.argv;
}

function envOf(
  options: TerminalPermDockOptions,
): Readonly<Record<string, string | undefined>> {
  return options.runtime?.env ?? process.env;
}

function isInteractive(options: TerminalPermDockOptions): boolean {
  if (typeof options.interactive === 'boolean') {
    return options.interactive;
  }
  if (options.interactive !== undefined) {
    return true;
  }
  const tty = options.runtime?.stdoutIsTTY ?? process.stdout.isTTY;
  return tty === true && envOf(options).CI === undefined;
}

function jsonOutput(options: TerminalPermDockOptions): boolean {
  if (options.output?.json !== undefined) {
    return options.output.json;
  }
  return argvOf(options).includes('--json');
}

function actorFromResolved(value: unknown): TerminalActor {
  if (value === null || value === undefined) {
    return {};
  }
  if (isSubject(value)) {
    const principal = value.principal;
    const actor: Actor | undefined =
      value.actor ??
      (principal === null
        ? undefined
        : {
            id: principal.id,
            kind: principal.kind ?? 'oauth-client',
          });
    return compact<TerminalActor>({
      actor,
      delegation: value.delegation,
    });
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'kind' in value &&
    typeof (value as Actor).id === 'string' &&
    typeof (value as Actor).kind === 'string'
  ) {
    return { actor: value as Actor };
  }
  return {};
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  if (data !== null && typeof data === 'object' && 'id' in data) {
    const id = (data as { readonly id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') {
      return { type: permission.resource, id: String(id) };
    }
  }
  return { type: permission.resource };
}

function defaultConfirm(input: {
  readonly permission: string;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly reason: string;
}): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const id =
    input.resource.id === undefined
      ? input.resource.type
      : `${input.resource.type} ${input.resource.id}`;
  return new Promise((resolve) => {
    rl.question(
      `${input.permission} on ${id} (${input.reason}). Continue? [y/N] `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      },
    );
  });
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: TerminalPermDockOptions<TUser>,
): TerminalPermDock {
  const write = writeOf(options);
  const exit = options.runtime?.exit ?? defaultExit;
  const runtime: TerminalRuntime = compact({
    ...options.runtime,
    configDir: options.runtime?.configDir ?? options.storage?.dir,
  });
  warnJwtInArgv(argvOf(options), write);

  let cached: Promise<PermDock> | undefined;
  let last: PermDock | undefined;
  let lastProfile = 'default';

  const tokenFor =
    (profile: string, force?: PermDockResolveOptions['source']): TokenHelper =>
    (sources: readonly TokenSource[]): Promise<string | null> =>
      resolveToken(
        sources,
        compact({
          profile,
          storage: options.storage,
          device: options.device,
          runtime,
          write,
          force,
        }),
      );

  const resolve = async (
    resolveOptions: PermDockResolveOptions = {},
  ): Promise<PermDock> => {
    const profile =
      resolveOptions.as ?? profileFromArgv(argvOf(options)) ?? 'default';
    lastProfile = profile;
    const context: TokenContext = {
      token: tokenFor(profile, resolveOptions.source),
      profile,
    };
    let user: TUser | null = null;
    try {
      user = await options.subject(context);
    } catch {
      user = null;
    }
    let actor: Actor | undefined;
    let delegation: Delegation | undefined;
    if (options.actor !== undefined) {
      try {
        const resolved = actorFromResolved(await options.actor(context));
        actor = resolved.actor;
        delegation = resolved.delegation;
      } catch {
        actor = undefined;
        delegation = undefined;
      }
    }
    const built = await createCorePermDock(
      policy,
      user,
      compact({
        tenant: options.tenant,
        actor,
        delegation,
        memberships: options.memberships,
        customRoles: options.customRoles,
        policies: options.policies,
        sink: options.sink,
        limits: options.limits,
      }),
    );
    last = built;
    return built;
  };

  const permdock = (
    resolveOptions: PermDockResolveOptions = {},
  ): Promise<PermDock> => {
    if (resolveOptions.refresh === true || cached === undefined) {
      cached = resolve(resolveOptions);
    }
    return cached;
  };

  const format = (
    decision: Decision,
    formatOptions: FormatOptions = {},
  ): string =>
    formatDecision(
      decision,
      compact<FormatOptions>({
        json: formatOptions.json ?? jsonOutput(options),
        permission: formatOptions.permission,
        instance: formatOptions.instance,
        subject: formatOptions.subject ?? last?.subject,
        approval: formatOptions.approval ?? options.approval,
      }),
    );

  const filterCommands = (
    entries: readonly CommandEntry[],
    filterOptions?: FilterCommandsOptions,
  ): readonly CommandEntry[] => {
    const next = filterOptions ?? { mode: 'hide' };
    return filterCommandEntries(next.permdock ?? last, entries, next);
  };

  const protect =
    <TArgs extends readonly unknown[], TData = unknown>(
      permission: Permission,
      load?: (...args: TArgs) => TData | Promise<TData>,
    ) =>
    (action: (context: ProtectContext<TData>, ...args: TArgs) => unknown) =>
    async (...args: TArgs): Promise<unknown> => {
      const instance = await permdock();
      let data: TData | undefined;
      if (load !== undefined) {
        data = await load(...args);
      }
      const decide = instance.decide as (
        next: Permission,
        row?: unknown,
        decideOptions?: {
          readonly source: 'adapter';
          readonly adapter: string;
        },
      ) => Decision;
      const first = decide(
        permission,
        data,
        compact({ source: 'adapter' as const, adapter: 'terminal' }),
      );

      if (first.outcome === 'denied') {
        write(format(first, { permission, subject: instance.subject }));
        return exit(exitCode(first));
      }

      let granted: Extract<Decision, { readonly outcome: 'granted' }>;
      if (first.outcome === 'granted') {
        granted = first;
      } else {
        if (!isInteractive(options)) {
          write(
            format(first, {
              permission,
              subject: instance.subject,
            }),
          );
          return exit(exitCode(first));
        }
        const confirm =
          typeof options.interactive === 'object'
            ? options.interactive.confirm
            : defaultConfirm;
        const promptToken = first.token;
        const accepted = await confirm({
          permission: permission.key,
          resource: resourceRef(permission, data),
          reason: first.reason,
          token: promptToken,
        });
        if (!accepted) {
          write(
            format(
              {
                outcome: 'denied',
                denials: [{ role: null, reason: 'approval' }],
                alternatives: [],
              },
              { permission, subject: instance.subject },
            ),
          );
          return exit(EX_NOPERM);
        }
        const again = decide(
          permission,
          data,
          compact({ source: 'adapter' as const, adapter: 'terminal' }),
        );
        if (again.outcome === 'denied') {
          write(format(again, { permission, subject: instance.subject }));
          return exit(exitCode(again));
        }
        if (again.outcome === 'granted') {
          granted = again;
        } else if (again.token === promptToken) {
          const principal = instance.subject.principal;
          if (principal === null) {
            write(format(again, { permission, subject: instance.subject }));
            return exit(EX_NOPERM);
          }
          granted = {
            outcome: 'granted',
            subject: { ...instance.subject, principal },
            matched: again.grant,
            token: again.token,
          };
        } else {
          write(format(again, { permission, subject: instance.subject }));
          return exit(EX_NOPERM);
        }
      }

      return action(
        {
          permdock: instance,
          data: data as TData,
          decision: granted,
        },
        ...args,
      );
    };

  const logout = async (): Promise<void> => {
    if (options.storage === undefined) {
      return;
    }
    const stored = readCredentials(options.storage, lastProfile, runtime);
    if (stored !== null) {
      await revokeCredential(options.device, stored, runtime);
    }
    deleteCredentials(options.storage, lastProfile, runtime);
    cached = undefined;
    last = undefined;
  };

  return {
    permdock,
    protect,
    filterCommands,
    format,
    exitCode,
    logout,
  };
}
