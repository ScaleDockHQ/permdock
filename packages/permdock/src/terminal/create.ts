import { createInterface } from "node:readline";

import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Actor, Delegation, Principal, Subject } from "../core/subject.ts";
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
  TypedConfirm,
} from "./types.ts";

import { resumeDecision, storedApprovalToken } from "../approvals/helpers.ts";
import { compact } from "../core/compact.ts";
import { createPermDock as createCorePermDock } from "../core/permdock.ts";
import { isSubject } from "../core/subject.ts";
import { revokeCredential } from "./device.ts";
import { defaultExit, EX_NOPERM, EX_USAGE } from "./exit.ts";
import { filterCommandEntries } from "./filter.ts";
import { exitCode, formatDecision } from "./format.ts";
import { deleteCredentials, readCredentials } from "./storage.ts";
import { profileFromArgv, resolveToken, warnJwtInArgv } from "./token.ts";

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

/**
 * The local y/N is the requester answering for themselves, so it stands in
 * for an approval only where the grant allows that (`distinct: false`) and no
 * agent is acting for the user.
 */
function answersLocally(
  decision: Extract<Decision, { readonly outcome: "approval-required" }>,
  subject: Subject,
): boolean {
  const approval = decision.grant.approval;
  return (
    typeof approval === "object" &&
    approval.distinct === false &&
    subject.actor === undefined
  );
}

function isInteractive(options: TerminalPermDockOptions): boolean {
  if (typeof options.interactive === "boolean") {
    return options.interactive;
  }
  if (options.interactive !== undefined) {
    return true;
  }
  const tty = options.runtime?.stdoutIsTTY ?? process.stdout.isTTY;
  return tty === true && envOf(options)["CI"] === undefined;
}

function jsonOutput(options: TerminalPermDockOptions): boolean {
  if (options.output?.json !== undefined) {
    return options.output.json;
  }
  return argvOf(options).includes("--json");
}

function flag(
  options: TerminalPermDockOptions,
  value: boolean | undefined,
  names: readonly string[],
): boolean {
  if (value !== undefined) {
    return value;
  }
  const argv = argvOf(options);
  return names.some((name) => argv.includes(name));
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
            kind: principal.kind ?? "oauth-client",
          });
    return compact<TerminalActor>({
      actor,
      delegation: value.delegation,
    });
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "kind" in value &&
    typeof value.id === "string" &&
    typeof value.kind === "string"
  ) {
    // SAFETY: id and kind were checked to be strings above; every other Actor field is optional.
    return { actor: value as Actor };
  }
  return {};
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  if (data !== null && typeof data === "object" && "id" in data) {
    const id = data.id;
    if (typeof id === "string" || typeof id === "number") {
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
  return new Promise((resolve) => {
    rl.question(
      `${input.permission} on ${describeResource(input.resource)} (${input.reason}). Continue? [y/N] `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      },
    );
  });
}

function describeResource(resource: {
  readonly type: string;
  readonly id?: string;
}): string {
  return resource.id === undefined
    ? resource.type
    : `${resource.type} ${resource.id}`;
}

const defaultTyped: TypedConfirm = (input) => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(
      `${input.permission} on ${describeResource(input.resource)} cannot be undone. Type ${input.expected} to continue: `,
      (answer) => {
        rl.close();
        resolve(answer);
      },
    );
  });
};

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: TerminalPermDockOptions<TUser>,
): TerminalPermDock<V> {
  const write = writeOf(options);
  const exit = options.runtime?.exit ?? defaultExit;
  const runtime: TerminalRuntime = compact({
    ...options.runtime,
    configDir: options.runtime?.configDir ?? options.storage?.dir,
  });
  warnJwtInArgv(argvOf(options), write);

  let cached: Promise<PermDock<V>> | undefined;
  let last: PermDock<V> | undefined;
  let lastProfile = "default";

  const tokenFor =
    (profile: string, force?: PermDockResolveOptions["source"]): TokenHelper =>
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
  ): Promise<PermDock<V>> => {
    const profile =
      resolveOptions.as ?? profileFromArgv(argvOf(options)) ?? "default";
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
        relations: options.relations,
        entitlements: options.entitlements,
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
  ): Promise<PermDock<V>> => {
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
    const next = filterOptions ?? { mode: "hide" };
    return filterCommandEntries(next.permdock ?? last, entries, next);
  };

  const protect =
    <TArgs extends readonly unknown[], TData = unknown>(
      permission: Permission,
      load?: (...args: TArgs) => TData | Promise<TData>,
    ) =>
    (action: (context: ProtectContext<TData, V>, ...args: TArgs) => unknown) =>
    async (...args: TArgs): Promise<unknown> => {
      const instance = await permdock();
      let data: TData | undefined;
      if (load !== undefined) {
        data = await load(...args);
      }
      // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
      const decide = instance.decide as (
        next: Permission,
        row?: unknown,
        decideOptions?: {
          readonly source: "adapter" | "simulate";
          readonly adapter: string;
        },
      ) => Decision;
      const dryRun = flag(options, options.dryRun, ["--dry-run"]);
      const first = decide(
        permission,
        data,
        dryRun
          ? { source: "simulate", adapter: "terminal" }
          : { source: "adapter", adapter: "terminal" },
      );

      if (dryRun) {
        write(
          first.outcome === "granted"
            ? jsonOutput(options)
              ? `${JSON.stringify({ outcome: "granted", permission: permission.key, dryRun: true })}\n`
              : `dry run: ${permission.key} on ${describeResource(resourceRef(permission, data))} is granted; nothing ran\n`
            : format(first, { permission, subject: instance.subject }),
        );
        return exit(exitCode(first));
      }

      if (first.outcome === "denied") {
        write(format(first, { permission, subject: instance.subject }));
        return exit(exitCode(first));
      }

      let granted: Extract<Decision, { readonly outcome: "granted" }>;
      if (first.outcome === "granted") {
        granted = first;
      } else if (answersLocally(first, instance.subject)) {
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
          typeof options.interactive === "object"
            ? (options.interactive.confirm ?? defaultConfirm)
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
                outcome: "denied",
                denials: [{ role: null, reason: "approval" }],
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
          compact({ source: "adapter" as const, adapter: "terminal" }),
        );
        if (again.outcome === "denied") {
          write(format(again, { permission, subject: instance.subject }));
          return exit(exitCode(again));
        }
        if (again.outcome === "granted") {
          granted = again;
        } else if (again.token === promptToken) {
          const principal = instance.subject.principal;
          if (principal === null) {
            write(format(again, { permission, subject: instance.subject }));
            return exit(EX_NOPERM);
          }
          granted = {
            outcome: "granted",
            subject: { ...instance.subject, principal },
            matched: again.grant,
            token: again.token,
          };
        } else {
          write(format(again, { permission, subject: instance.subject }));
          return exit(EX_NOPERM);
        }
      } else {
        if (options.store === undefined) {
          write(format(first, { permission, subject: instance.subject }));
          if (!jsonOutput(options)) {
            write(
              `${permission.key} needs someone other than you to approve it: pass a store to createPermDock so the request can be approved and the command rerun\n`,
            );
          }
          return exit(EX_NOPERM);
        }
        const resumed = await resumeDecision({
          decision: first,
          permission,
          subject: instance.subject,
          store: options.store,
          resource: resourceRef(permission, data),
          adapter: "terminal",
          token: await storedApprovalToken(options.store, first),
        });
        if (resumed.outcome !== "granted") {
          write(format(resumed, { permission, subject: instance.subject }));
          return exit(exitCode(resumed));
        }
        granted = resumed;
      }

      if (
        permission.meta.destructive === true &&
        !flag(options, options.yes, ["--yes", "-y"])
      ) {
        const resource = resourceRef(permission, data);
        if (!isInteractive(options)) {
          write(
            `${permission.key} on ${describeResource(resource)} is destructive: pass --yes to run it without a terminal\n`,
          );
          return exit(EX_USAGE);
        }
        const typed =
          typeof options.interactive === "object"
            ? (options.interactive.typed ?? defaultTyped)
            : defaultTyped;
        const expected = resource.id ?? permission.key;
        const answer = await typed({
          permission: permission.key,
          resource,
          expected,
        });
        if (answer.trim() !== expected) {
          write(`${permission.key}: confirmation did not match; nothing ran\n`);
          return exit(EX_NOPERM);
        }
      }

      // SAFETY: TData is load's result type; data is undefined only when no load was passed.
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
