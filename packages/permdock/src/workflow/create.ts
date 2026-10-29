import type { ApprovalStore } from "../approvals/types.ts";
import type { Automation, AutomationSource } from "../core/automation.ts";
import type { Decision, Denial } from "../core/decision.ts";
import type { AuthEvent, SinkEvent } from "../core/event-types.ts";
import type {
  DecisionSink,
  TokenSigner,
  TokenVerifier,
} from "../core/interfaces.ts";
import type {
  DecideOptions,
  PermDock,
  PermDockOptions,
} from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { PrincipalSource } from "../core/principal-source.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { AuthorizationDetail } from "../core/subject.ts";
import type { Instant } from "../core/time.ts";
import type {
  RunAutomation,
  RunBinding,
  RunPrincipal,
  RunResource,
} from "../server/run-ticket.ts";
import type { ApprovalWaiter } from "./waiter.ts";

import { requestApproval, resumeDecision } from "../approvals/helpers.ts";
import { withApp } from "../core/app.ts";
import { parseAutomation } from "../core/automation.ts";
import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { isId } from "../core/ids.ts";
import { getPermDock as getCorePermDock } from "../core/permdock.ts";
import { findPermission } from "../core/permission-registry.ts";
import { automationEvent } from "../core/sink.ts";
import { isThenable } from "../core/thenable.ts";
import { signRunTicket, subjectFromRunTicket } from "../server/run-ticket.ts";

function writeQuietly(sink: DecisionSink, event: SinkEvent): void {
  try {
    const written = sink.write([event]);
    if (isThenable(written)) {
      void Promise.resolve(written).catch(() => undefined);
    }
  } catch {
    // a sink never influences a run
  }
}

export type WorkflowPermDockOptions = PermDockOptions & {
  /** Signs the run tickets `start` mints. */
  readonly signer: TokenSigner;
  /** Verifies run tickets in `getPermDock`. */
  readonly verifier: TokenVerifier;
  /** Loads the principal a run acts as, live, on every `getPermDock`. */
  readonly principals: PrincipalSource;
  /** The live automation records, read by `start` and on every `getPermDock`. */
  readonly automations: AutomationSource;
  /**
   * Where `awaitApproval` opens and resumes requests; the same option name as
   * every other adapter.
   */
  readonly store?: ApprovalStore;
  /** Suspends `awaitApproval` until a request is decided. */
  readonly waiter?: ApprovalWaiter;
  readonly audience?: string | readonly string[];
  readonly issuer?: string;
  /** Run ticket lifetime in seconds. Defaults to 86400; a run past it denies. */
  readonly expiresIn?: number;
  readonly onAuth?: (event: AuthEvent) => void;
};

export type AutomationOptions = {
  /** The tenant the automation is read for. */
  readonly tenant?: string;
  /**
   * The caller starting the run. It needs only the automation's `run`
   * permission and lends the run nothing. Absent: server code starts the run,
   * which an automation without `run` requires.
   */
  readonly caller?: PermDock;
  /** The row `run` is decided on, when it is an instance permission. */
  readonly row?: unknown;
  /**
   * The event that started the run, as JSON. Kept in `subject.context.trigger`;
   * never a grant.
   */
  readonly trigger?: Readonly<Record<string, unknown>>;
  /** The run id (`jti`); a fresh UUID when absent. */
  readonly id?: string;
  readonly binding?: RunBinding;
  /**
   * The record the run is bound to. The automation's permissions on
   * `resource.type` then hold on that id only, through an
   * `authorization_details` `identifier`; a check on another id, or with no
   * row, denies. Its other permissions are unchanged. A type none of its
   * permissions is on denies the start.
   */
  readonly resource?: RunResource;
  readonly now?: Instant;
};

export type StartAutomationResult =
  | {
      readonly outcome: "started";
      readonly ticket: string;
      readonly run: {
        readonly id: string;
        readonly automation: RunAutomation;
        readonly resource?: RunResource;
      };
    }
  | { readonly outcome: "denied"; readonly denials: readonly Denial[] };

export type AwaitApprovalOptions = DecideOptions & {
  /**
   * The resource the approval request names; defaults to the permission's
   * resource and the row's `id`.
   */
  readonly resource?: { readonly type: string; readonly id?: string };
  /** Seconds the request stays open; the store's `ttl` when absent. */
  readonly ttl?: number;
  readonly signal?: AbortSignal;
};

export type WorkflowPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  /**
   * Starts a run of the automation `id` and returns its run ticket. Denied when
   * the automation is unknown or revoked (`validation`) or when the caller is
   * not granted its `run` permission.
   */
  readonly start: (
    id: string,
    options?: AutomationOptions,
  ) => Promise<StartAutomationResult>;
  /**
   * The PermDock of a run, rebuilt from its ticket: the principal loaded live,
   * narrowed to the automation's permissions and to any policy delegation to
   * `actor('automation')`. A changed, revoked or unknown automation, or a
   * publisher who is gone, gives an anonymous instance that denies everything.
   */
  readonly getPermDock: (ticket: string) => Promise<PermDock<V>>;
  /**
   * Decides `permission`; on `approval-required` opens a request, waits on the
   * `waiter`, then rebuilds the run from its ticket and decides again with the
   * token. The second decision reads the publisher's rights as of then, so a
   * demotion while waiting denies.
   */
  readonly awaitApproval: (
    ticket: string,
    permission: Permission,
    data?: unknown,
    options?: AwaitApprovalOptions,
  ) => Promise<Decision>;
  /**
   * The first half of `awaitApproval`, for runners that wait outside the call:
   * decides, and on `approval-required` opens the request and returns the
   * decision with its token.
   */
  readonly openApproval: (
    ticket: string,
    permission: Permission,
    data?: unknown,
    options?: AwaitApprovalOptions,
  ) => Promise<Decision>;
  /**
   * The second half: rebuilds the run from its ticket and decides again with
   * the approval `token`. A request still pending denies with reason
   * `approval`.
   */
  readonly resumeApproval: (
    ticket: string,
    permission: Permission,
    token: string,
    data?: unknown,
    options?: AwaitApprovalOptions,
  ) => Promise<Decision>;
};

const DEFAULT_TTL = 86_400;

function deniedStart(
  reason: Denial["reason"],
  detail?: unknown,
): StartAutomationResult {
  return freezeDeep({
    outcome: "denied" as const,
    denials: [compact<Denial>({ role: null, reason, detail })],
  });
}

async function readAutomation(
  source: AutomationSource,
  id: string,
  tenant: string | undefined,
): Promise<Automation | undefined> {
  try {
    const found = await source.automation(id, compact({ tenant }));
    const parsed = found === null ? undefined : parseAutomation(found);
    return parsed === undefined || parsed.revoked === true ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function idOf(row: unknown): string | undefined {
  if (row === null || typeof row !== "object") {
    return undefined;
  }
  const id: unknown = Reflect.get(row, "id");
  return typeof id === "string" ? id : undefined;
}

function targetOf(
  permission: Permission,
  data: unknown,
  resource: AwaitApprovalOptions["resource"],
): { readonly type: string; readonly id?: string } {
  return resource ?? compact({ type: permission.resource, id: idOf(data) });
}

/**
 * Creates the PermDock for durable runs of published automations. A run acts as
 * the automation's principal with that principal's rights at each step,
 * narrowed to the automation's operations; the trigger is recorded and never
 * grants.
 */
export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  given: WorkflowPermDockOptions,
): WorkflowPermDock<V> {
  const options = withApp(policy, given);
  const {
    signer,
    verifier,
    principals,
    automations,
    store: approvals,
    waiter,
    audience,
    issuer,
    expiresIn = DEFAULT_TTL,
    onAuth,
    ...permdockOptions
  } = options;

  const instanceFor = (subject: Subject): Promise<PermDock<V>> =>
    getCorePermDock(policy, subject, permdockOptions);

  const publisherCanAssign = async (
    automation: Automation,
  ): Promise<boolean> => {
    const publisher = await principals.principal(
      automation.publishedBy,
      compact({ tenant: automation.tenant }),
    );
    if (publisher === null) {
      return false;
    }
    const instance = await instanceFor({ principal: publisher, context: {} });
    const roles = new Set(
      instance
        .assignableRoles(compact({ tenant: automation.tenant }))
        .map((role) => role.key),
    );
    const ceiling = new Set(
      instance
        .assignablePermissions(compact({ tenant: automation.tenant }))
        .map((leaf) => leaf.key),
    );
    return (
      (automation.roles ?? []).every((role) => roles.has(role)) &&
      automation.permissions.every((key) => ceiling.has(key))
    );
  };

  const getPermDock = async (ticket: string): Promise<PermDock<V>> => {
    let current: Automation | undefined;
    const tracked: AutomationSource = {
      async automation(id, readOptions) {
        current = await readAutomation(automations, id, readOptions?.tenant);
        return current ?? null;
      },
    };
    const live: PrincipalSource = {
      async principal(id, readOptions) {
        if (current === undefined) {
          return principals.principal(id, readOptions);
        }
        if (id !== current.principal) {
          return null;
        }
        if (current.mode === "publisher") {
          return principals.principal(id, readOptions);
        }
        if (
          current.tenant === undefined ||
          !(await publisherCanAssign(current))
        ) {
          return null;
        }
        return freezeDeep({
          id: current.principal,
          kind: "service" as const,
          tenant: current.tenant,
          memberships: [
            { scope: "tenant", id: current.tenant, roles: current.roles ?? [] },
          ],
        });
      },
    };
    let subject: Subject<RunPrincipal>;
    try {
      subject = await subjectFromRunTicket(
        ticket,
        compact({
          verifier,
          principals: live,
          automations: tracked,
          audience,
          issuer,
          onAuth,
        }),
      );
    } catch {
      subject = { principal: null, context: {} };
    }
    return instanceFor(subject);
  };

  const start = async (
    id: string,
    startOptions: AutomationOptions = {},
  ): Promise<StartAutomationResult> => {
    const automation = await readAutomation(
      automations,
      id,
      startOptions.tenant,
    );
    if (automation === undefined) {
      return deniedStart("validation", { cause: "automation-unavailable" });
    }
    const { caller } = startOptions;
    if (caller !== undefined) {
      const run =
        automation.run === undefined
          ? undefined
          : findPermission(policy.permissions, automation.run);
      if (run === undefined) {
        return deniedStart("no-grant", { permission: automation.run ?? null });
      }
      const decision = caller.decide(run, startOptions.row);
      if (decision.outcome !== "granted") {
        return freezeDeep({
          outcome: "denied" as const,
          denials:
            decision.outcome === "denied"
              ? decision.denials
              : [{ role: null, reason: "approval" as const }],
        });
      }
    }
    const { resource } = startOptions;
    if (resource !== undefined && !(isId(resource.type) && isId(resource.id))) {
      return deniedStart("validation", { cause: "resource-invalid" });
    }
    const scopes: string[] = [];
    const bound: string[] = [];
    for (const key of automation.permissions) {
      const leaf = findPermission(policy.permissions, key);
      if (leaf === undefined) {
        return deniedStart("validation", { permission: key });
      }
      if (resource !== undefined && leaf.resource === resource.type) {
        bound.push(leaf.action);
      } else {
        scopes.push(leaf.scope);
      }
    }
    if (resource !== undefined && bound.length === 0) {
      return deniedStart("validation", { resource: resource.type });
    }
    const authorizationDetails: readonly AuthorizationDetail[] | undefined =
      resource === undefined
        ? undefined
        : [{ type: resource.type, identifier: resource.id, actions: bound }];
    const runId = startOptions.id ?? globalThis.crypto.randomUUID();
    const runAutomation = { id: automation.id, version: automation.version };
    const signed = await signRunTicket(
      compact({
        principal: automation.principal,
        kind: "automation" as const,
        actor: { id: automation.id, kind: "automation" },
        delegation: compact({ scopes, authorizationDetails }),
        automation: runAutomation,
        tenant: automation.tenant,
        trigger: startOptions.trigger,
        binding: startOptions.binding,
        resource,
        id: runId,
        expiresIn,
      }),
      signer,
      compact({ audience, now: startOptions.now }),
    );
    if (permdockOptions.sink !== undefined) {
      writeQuietly(
        permdockOptions.sink,
        automationEvent({ operation: "run", automation, run: runId }),
      );
    }
    return freezeDeep({
      outcome: "started" as const,
      ticket: signed,
      run: compact({ id: runId, automation: runAutomation, resource }),
    });
  };

  const opened = async (
    ticket: string,
    permission: Permission,
    data: unknown,
    decideOptions: AwaitApprovalOptions,
  ): Promise<{ readonly decision: Decision; readonly expiresAt?: string }> => {
    const { resource, ttl, signal: _signal, ...rest } = decideOptions;
    const first = await getPermDock(ticket);
    const decision = first.decide(permission, data, rest);
    if (decision.outcome !== "approval-required" || approvals === undefined) {
      return { decision };
    }
    const request = await requestApproval(
      approvals,
      decision,
      compact({
        permission,
        resource: targetOf(permission, data, resource),
        subject: first.subject,
        adapter: "workflow",
        ttl,
      }),
    );
    return { decision, expiresAt: request.expiresAt };
  };

  const openApproval = async (
    ticket: string,
    permission: Permission,
    data?: unknown,
    decideOptions: AwaitApprovalOptions = {},
  ): Promise<Decision> =>
    (await opened(ticket, permission, data, decideOptions)).decision;

  const resumeApproval = async (
    ticket: string,
    permission: Permission,
    token: string,
    data?: unknown,
    decideOptions: AwaitApprovalOptions = {},
  ): Promise<Decision> => {
    const { resource, ttl: _ttl, signal: _signal, ...rest } = decideOptions;
    const run = await getPermDock(ticket);
    const decision = run.decide(permission, data, rest);
    if (approvals === undefined) {
      return decision;
    }
    return resumeDecision({
      decision,
      permission,
      subject: run.subject,
      store: approvals,
      resource: targetOf(permission, data, resource),
      adapter: "workflow",
      token,
    });
  };

  const awaitApproval = async (
    ticket: string,
    permission: Permission,
    data?: unknown,
    decideOptions: AwaitApprovalOptions = {},
  ): Promise<Decision> => {
    if (waiter === undefined) {
      const {
        resource: _resource,
        ttl: _ttl,
        signal: _signal,
        ...rest
      } = decideOptions;
      return (await getPermDock(ticket)).decide(permission, data, rest);
    }
    const { decision, expiresAt } = await opened(
      ticket,
      permission,
      data,
      decideOptions,
    );
    if (decision.outcome !== "approval-required" || expiresAt === undefined) {
      return decision;
    }
    try {
      await waiter.wait(
        decision.token,
        compact({
          expiresAt: { epochMilliseconds: Date.parse(expiresAt) },
          signal: decideOptions.signal,
        }),
      );
    } catch {
      // The store decides below: a request still pending denies with reason approval.
    }
    return resumeApproval(
      ticket,
      permission,
      decision.token,
      data,
      decideOptions,
    );
  };

  return Object.freeze({
    start,
    getPermDock,
    awaitApproval,
    openApproval,
    resumeApproval,
  });
}
