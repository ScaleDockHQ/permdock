import type { Denial } from "./decision.ts";
import type { Operation } from "./operations.ts";
import type { PermDock } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { Instant } from "./time.ts";

import { compact, isReadonlyArray } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { idList, isId } from "./ids.ts";
import { type InstanceHandle, internalsOf } from "./internals.ts";
import { ownRecord } from "./paths.ts";
import { findPermission } from "./permission-registry.ts";
import { isRfc3339, nowSeconds, rfc3339 } from "./time.ts";

/**
 * Who an automation runs as. `publisher`: the person who published it, with
 * their rights as of each run. `service`: a `kind: 'service'` principal holding
 * `roles` in `tenant`, capped at what the publisher could assign.
 */
export type AutomationMode = "publisher" | "service";

/**
 * Automation v1: a published, versioned run of operations. Every run acts as
 * `principal` with live rights, narrowed to `permissions` (the operations'
 * permissions) and to any policy delegation to `actor('automation')`. The event
 * that triggers a run never grants.
 */
export type Automation = {
  readonly v: 1;
  readonly id: string;
  /** Changes on every edit; a run ticket for another version is refused. */
  readonly version: number | string;
  readonly mode: AutomationMode;
  /** The principal each run acts as: the publisher, or the service principal. */
  readonly principal: string;
  readonly publishedBy: string;
  /** RFC 3339. */
  readonly publishedAt: string;
  readonly tenant?: string;
  /** Service mode only: the roles the service principal holds in `tenant`. */
  readonly roles?: readonly string[];
  /** The operation names the automation runs. */
  readonly operations: readonly string[];
  /** The delegation: the permission keys of `operations`. */
  readonly permissions: readonly string[];
  /**
   * The permission key a caller needs to start a run; absent, only server code
   * starts one.
   */
  readonly run?: string;
  readonly revoked?: boolean;
  readonly name?: string;
};

/** The live record of each automation, read on every run. */
export type AutomationSource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  /**
   * The automation as of now, or `null` for an unknown one. A throw is no
   * automation.
   */
  automation: (
    id: string,
    options?: { readonly tenant?: string },
  ) => Automation | null | Promise<Automation | null>;
};

type OperationRef = Pick<Operation, "name" | "permission">;

export type AutomationRequest = {
  readonly id: string;
  readonly version: number | string;
  /**
   * The operations the automation runs: entries of an `OperationMap`, or the
   * map itself.
   */
  readonly operations:
    | readonly OperationRef[]
    | Readonly<Record<string, OperationRef>>;
  /** Defaults to `'publisher'`. */
  readonly mode?: AutomationMode;
  /** Defaults to the publisher's active tenant; required for `service`. */
  readonly tenant?: string;
  /** Service mode: the service principal's id; defaults to `automation:<id>`. */
  readonly principal?: string;
  /** Service mode: the roles the service principal holds in `tenant`. */
  readonly roles?: readonly string[];
  /** The permission a caller needs to start a run. */
  readonly run?: Permission;
  readonly name?: string;
};

export type AutomationDecision =
  | { readonly outcome: "granted"; readonly automation: Automation }
  | { readonly outcome: "denied"; readonly denials: readonly Denial[] };

export type DecideAutomationOptions = {
  /** The publication time; defaults to the clock. */
  readonly now?: Instant;
};

const MAX_NAME = 256;

function isVersion(value: unknown): value is number | string {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    isId(value)
  );
}

/**
 * Validates an untrusted automation record and returns a frozen copy with only
 * the v1 fields, or `undefined`. A service automation needs `tenant` and
 * `roles`; a publisher automation runs as `publishedBy` and has no `roles`.
 */
export function parseAutomation(input: unknown): Automation | undefined {
  const value = ownRecord(input);
  if (
    value === undefined ||
    value["v"] !== 1 ||
    !isId(value["id"]) ||
    !isVersion(value["version"]) ||
    (value["mode"] !== "publisher" && value["mode"] !== "service") ||
    !isId(value["principal"]) ||
    !isId(value["publishedBy"]) ||
    !isRfc3339(value["publishedAt"])
  ) {
    return undefined;
  }
  const operations = idList(value["operations"]);
  const permissions = idList(value["permissions"]);
  const roles =
    value["roles"] === undefined ? undefined : idList(value["roles"]);
  const { tenant, run, revoked, name } = value;
  if (
    operations === undefined ||
    permissions === undefined ||
    (value["roles"] !== undefined && roles === undefined) ||
    (tenant !== undefined && !isId(tenant)) ||
    (run !== undefined && !isId(run)) ||
    (revoked !== undefined && typeof revoked !== "boolean") ||
    (name !== undefined && (typeof name !== "string" || name.length > MAX_NAME))
  ) {
    return undefined;
  }
  if (value["mode"] === "service") {
    if (tenant === undefined || roles === undefined) {
      return undefined;
    }
  } else if (
    roles !== undefined ||
    value["principal"] !== value["publishedBy"]
  ) {
    return undefined;
  }
  return freezeDeep(
    compact<Automation>({
      v: 1,
      id: value["id"],
      version: value["version"],
      mode: value["mode"],
      principal: value["principal"],
      publishedBy: value["publishedBy"],
      publishedAt: value["publishedAt"],
      tenant,
      roles,
      operations,
      permissions,
      run,
      revoked: revoked === true ? true : undefined,
      name,
    }),
  );
}

export type MemoryAutomationSource = {
  automation: (
    id: string,
    options?: { readonly tenant?: string },
  ) => Automation | null;
  /** Adds or replaces a record by id; an invalid record throws. */
  put: (automation: Automation) => void;
};

/**
 * An in-process `AutomationSource`; records are kept by id and checked with
 * `parseAutomation`.
 */
export function memoryAutomationSource(
  automations: readonly Automation[] = [],
): MemoryAutomationSource {
  const byId = new Map<string, Automation>();
  const put = (automation: Automation): void => {
    const parsed = parseAutomation(automation);
    if (parsed === undefined) {
      throw new TypeError("PermDock: invalid automation record");
    }
    byId.set(parsed.id, parsed);
  };
  for (const automation of automations) {
    put(automation);
  }
  return Object.freeze({
    automation(
      id: string,
      options?: { readonly tenant?: string },
    ): Automation | null {
      const found = byId.get(id);
      if (
        found === undefined ||
        (options?.tenant !== undefined &&
          found.tenant !== undefined &&
          found.tenant !== options.tenant)
      ) {
        return null;
      }
      return found;
    },
    put,
  });
}

function denied(
  reason: Denial["reason"],
  detail?: unknown,
): AutomationDecision {
  return freezeDeep({
    outcome: "denied" as const,
    denials: [compact<Denial>({ role: null, reason, detail })],
  });
}

function operationList(
  operations: AutomationRequest["operations"],
): readonly OperationRef[] {
  return isReadonlyArray(operations) ? operations : Object.values(operations);
}

/**
 * Decides whether the subject of `permdock` may publish the automation in
 * `request`, and returns the record to store. The publisher must be a signed-in
 * user or service that is not a link, a feed, a contact, a credential or a run,
 * and must be able to use every operation's permission now (`exceeds-creator`);
 * each run re-checks their live rights. A `service` automation's tenant must be
 * one the publisher is a member of, its roles among their `assignableRoles`
 * there and its permissions within `assignablePermissions`. PermDock never
 * stores the record; the application does, after a `granted` result.
 */
/**
 * Decides whether the subject of `permdock` may publish the automation in
 * `request` and returns the record to store: the publisher's own reach over
 * every operation's permission and, for a `service` automation, their
 * assignable ceiling. Each run re-checks the publisher live. An instance built
 * from a snapshot denies with `unsupported`.
 */
export function decideAutomation(
  permdock: InstanceHandle,
  request: AutomationRequest,
  options: DecideAutomationOptions = {},
): Promise<AutomationDecision> {
  const internals = internalsOf(permdock);
  if (internals === undefined) {
    return Promise.resolve(
      freezeDeep({
        outcome: "denied" as const,
        denials: [{ role: null, reason: "unsupported" as const }],
      }),
    );
  }
  return Promise.resolve().then(() =>
    decideAutomationWith(internals.instance, request, options),
  );
}

function decideAutomationWith(
  permdock: PermDock,
  request: AutomationRequest,
  options: DecideAutomationOptions,
): AutomationDecision {
  const publisher = permdock.subject.principal;
  if (publisher === null) {
    return denied("anonymous");
  }
  if (
    publisher.kind === "link" ||
    publisher.kind === "feed" ||
    publisher.kind === "contact"
  ) {
    return denied("exceeds-creator", { creator: publisher.kind });
  }
  if ("credential" in publisher || "runTicket" in publisher) {
    return denied("exceeds-creator", {
      creator: "credential" in publisher ? "credential" : "run",
    });
  }
  const mode = request.mode ?? "publisher";
  const refs = operationList(request.operations);
  if (
    !isId(request.id) ||
    !isVersion(request.version) ||
    refs.length === 0 ||
    (mode !== "publisher" && mode !== "service")
  ) {
    return denied("validation");
  }
  const names: string[] = [];
  const keys: string[] = [];
  for (const ref of refs) {
    const leaf = findPermission(permdock.permissions, ref.permission.key);
    if (!isId(ref.name) || leaf === undefined || names.includes(ref.name)) {
      return denied("validation");
    }
    names.push(ref.name);
    if (!keys.includes(leaf.key)) {
      keys.push(leaf.key);
    }
    if (!permdock.mayUse(leaf)) {
      return denied("exceeds-creator", { permission: leaf.key });
    }
  }
  const run =
    request.run === undefined
      ? undefined
      : findPermission(permdock.permissions, request.run.key);
  if (request.run !== undefined && run === undefined) {
    return denied("validation");
  }
  const tenant = request.tenant ?? publisher.tenant;
  if (tenant !== undefined && !permdock.tenants().includes(tenant)) {
    return denied("exceeds-creator", { tenant });
  }
  if (mode === "service") {
    if (tenant === undefined || request.roles === undefined) {
      return denied("validation");
    }
    const assignable = new Set(
      permdock.assignableRoles({ tenant }).map((role) => role.key),
    );
    for (const role of request.roles) {
      if (!assignable.has(role)) {
        return denied("exceeds-creator", { role });
      }
    }
    const ceiling = new Set(
      permdock.assignablePermissions({ tenant }).map((leaf) => leaf.key),
    );
    for (const key of keys) {
      if (!ceiling.has(key)) {
        return denied("exceeds-creator", { permission: key });
      }
    }
  }
  const automation = parseAutomation(
    compact({
      v: 1,
      id: request.id,
      version: request.version,
      mode,
      principal:
        mode === "service"
          ? (request.principal ?? `automation:${request.id}`)
          : publisher.id,
      publishedBy: publisher.id,
      publishedAt: rfc3339(nowSeconds(options.now)),
      tenant,
      roles: mode === "service" ? request.roles : undefined,
      operations: names,
      permissions: keys,
      run: run?.key,
      name: request.name,
    }),
  );
  if (automation === undefined) {
    return denied("validation");
  }
  return freezeDeep({ outcome: "granted" as const, automation });
}
