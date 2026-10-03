import type {
  Actor,
  PermDockOptions,
  Delegation,
  LimitStore,
  Permission,
  Principal,
  Subject,
} from "../../index.ts";
import type { SaasDoc, SaasFolder, SaasProject } from "./permissions.ts";

import { memoryLimitStore, memoryRoleSource } from "../../index.ts";
import { saasPermissions as p } from "./permissions.ts";
import { SAAS_API_KEY_LIMIT } from "./policy.ts";
import {
  saasCustomRoles,
  saasPrincipal,
  saasRelations,
  saasSeed,
} from "./seed.ts";

export type SaasOutcome = "granted" | "denied" | "approval-required";

export type SaasScenario = {
  readonly name: string;
  readonly user: string;
  /** The requested tenant, as a route or header would pass it. */
  readonly tenant?: string;
  readonly permission: Permission;
  readonly row?: SaasProject | SaasDoc | SaasFolder;
  readonly expected: {
    readonly outcome: SaasOutcome;
    /** One reason that must appear among the denials. */
    readonly reason?: string;
  };
  /**
   * `false` when the outcome depends on server-only inputs (a quota store,
   * approvals), so a snapshot client is not expected to match.
   */
  readonly client?: boolean;
  /**
   * The client outcome when it is stricter than the server's: a snapshot
   * cannot evaluate a closure deny, so it fails closed.
   */
  readonly clientOutcome?: SaasOutcome;
  /** An agent acting for `user`; without `delegation` it reaches nothing. */
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  /** Units of the daily api-key quota this subject already used in the tenant. */
  readonly quotaUsed?: number;
};

/** What the policy's `subject` receives: the principal, or a `Subject` carrying the actor. */
export function saasUser(scenario: SaasScenario): Principal | Subject {
  const principal = saasPrincipal(scenario.user, scenario.tenant);
  if (scenario.actor === undefined && scenario.delegation === undefined) {
    return principal;
  }
  return {
    principal,
    context: {},
    ...(scenario.actor === undefined ? {} : { actor: scenario.actor }),
    ...(scenario.delegation === undefined
      ? {}
      : { delegation: scenario.delegation }),
  };
}

/** A memory quota store in which every subject has already used `used` units. */
export function saasLimitStore(used = 0): LimitStore {
  const inner = memoryLimitStore();
  const primed = new Set<string>();
  const prime = (input: Parameters<LimitStore["consume"]>[0]): void => {
    const id = [input.key, input.subjectId, input.tenant ?? ""].join("\u0000");
    if (primed.has(id)) {
      return;
    }
    primed.add(id);
    for (let index = 0; index < used; index += 1) {
      void inner.consume(input);
    }
  };
  return {
    consume(input) {
      prime(input);
      return inner.consume(input);
    },
    remaining(input) {
      prime(input);
      return inner.remaining(input);
    },
  };
}

/** The `createPermDock` options a scenario runs with: tenant, custom roles, quota and folder tree. */
export function saasScenarioOptions(scenario: SaasScenario): PermDockOptions {
  return {
    ...(scenario.tenant === undefined ? {} : { tenant: scenario.tenant }),
    customRoles: memoryRoleSource(saasCustomRoles),
    limits: saasLimitStore(scenario.quotaUsed),
    relations: saasRelations(),
  };
}

export function saasProject(id: string): SaasProject {
  const row = saasSeed.projects.find((project) => project.id === id);
  if (row === undefined) {
    throw new Error(`unknown fixture project ${id}`);
  }
  return row;
}

export function saasDoc(id: string): SaasDoc {
  const row = saasSeed.docs.find((doc) => doc.id === id);
  if (row === undefined) {
    throw new Error(`unknown fixture doc ${id}`);
  }
  return row;
}

export function saasFolder(id: string): SaasFolder {
  const row = saasSeed.folders.find((folder) => folder.id === id);
  if (row === undefined) {
    throw new Error(`unknown fixture folder ${id}`);
  }
  return row;
}

/**
 * The folder tree, decided with `createPermDock({ relations: saasRelations() })`.
 * A snapshot carries no graph, so every graph grant is server-only on a client.
 */
export const saasFolderScenarios: readonly SaasScenario[] = Object.freeze([
  {
    name: "a viewer of the root reads a folder three levels down",
    user: "bob",
    tenant: "acme",
    permission: p.folder.read,
    row: saasFolder("infra"),
    expected: { outcome: "granted" },
    clientOutcome: "denied",
  },
  {
    name: "a viewer of the root does not reach a restricted branch",
    user: "bob",
    tenant: "acme",
    permission: p.folder.read,
    row: saasFolder("payroll"),
    expected: { outcome: "denied" },
  },
  {
    name: "a viewer of the restricted folder reads inside it",
    user: "hank",
    tenant: "acme",
    permission: p.folder.read,
    row: saasFolder("payroll"),
    expected: { outcome: "granted" },
    clientOutcome: "denied",
  },
  {
    name: "an editor of a folder updates its descendants but not its parent",
    user: "gina",
    tenant: "acme",
    permission: p.folder.update,
    row: saasFolder("platform"),
    expected: { outcome: "granted" },
    clientOutcome: "denied",
  },
  {
    name: "an editor does not update above the shared folder",
    user: "gina",
    tenant: "acme",
    permission: p.folder.update,
    row: saasFolder("root"),
    expected: { outcome: "denied" },
  },
  {
    name: "an expired share reaches nothing",
    user: "frank",
    tenant: "acme",
    permission: p.folder.read,
    row: saasFolder("eng"),
    expected: { outcome: "denied" },
  },
  {
    name: "an admin reads every folder in the org, restricted or not",
    user: "alice",
    tenant: "acme",
    permission: p.folder.read,
    row: saasFolder("payroll"),
    expected: { outcome: "granted" },
  },
]);

/**
 * Hand-written expectations. Never derive `expected` from the engine: the
 * list is the oracle every adapter, ORM and client suite runs against.
 */
export const saasScenarios: readonly SaasScenario[] = Object.freeze([
  {
    name: "admin updates any project in their org",
    user: "alice",
    tenant: "acme",
    permission: p.project.update,
    row: saasProject("p1"),
    expected: { outcome: "granted" },
  },
  {
    name: "viewer in the second org cannot update there",
    user: "alice",
    tenant: "globex",
    permission: p.project.update,
    row: saasProject("g1"),
    expected: { outcome: "denied" },
  },
  {
    name: "viewer in the second org reads there",
    user: "alice",
    tenant: "globex",
    permission: p.project.read,
    row: saasProject("g1"),
    expected: { outcome: "granted" },
  },
  {
    name: "admin in acme cannot read a globex row while acting in acme",
    user: "alice",
    tenant: "acme",
    permission: p.project.read,
    row: saasProject("g1"),
    expected: { outcome: "denied" },
  },
  {
    name: "member updates their own project",
    user: "bob",
    tenant: "acme",
    permission: p.project.update,
    row: saasProject("p1"),
    expected: { outcome: "granted" },
  },
  {
    name: "member cannot update a colleague project",
    user: "bob",
    tenant: "acme",
    permission: p.project.update,
    row: saasProject("p2"),
    expected: { outcome: "denied" },
  },
  {
    name: "archived project cannot be deleted by its owner",
    user: "bob",
    tenant: "acme",
    permission: p.project.delete,
    row: saasProject("p4"),
    expected: { outcome: "denied" },
  },
  {
    name: "archived project cannot be deleted by the org owner",
    user: "carol",
    tenant: "acme",
    permission: p.project.delete,
    row: saasProject("p4"),
    expected: { outcome: "denied" },
  },
  {
    name: "owner manages billing",
    user: "carol",
    tenant: "acme",
    permission: p.billing.manage,
    expected: { outcome: "granted" },
  },
  {
    name: "admin cannot read billing",
    user: "alice",
    tenant: "acme",
    permission: p.billing.read,
    expected: { outcome: "denied" },
  },
  {
    name: "free plan hides analytics from admins",
    user: "alice",
    tenant: "acme",
    permission: p.analytics.read,
    expected: { outcome: "denied", reason: "not-entitled" },
  },
  {
    name: "pro plan shows analytics to admins",
    user: "erin",
    tenant: "globex",
    permission: p.analytics.read,
    expected: { outcome: "granted" },
  },
  {
    name: "same admin, free org: no analytics",
    user: "erin",
    tenant: "acme",
    permission: p.analytics.read,
    expected: { outcome: "denied", reason: "not-entitled" },
  },
  {
    name: "custom contractor role inherits member create",
    user: "dave",
    tenant: "acme",
    permission: p.project.create,
    expected: { outcome: "granted" },
  },
  {
    name: "custom contractor role cannot update a project it does not own",
    user: "dave",
    tenant: "acme",
    permission: p.project.update,
    row: saasProject("p1"),
    expected: { outcome: "denied" },
  },
  {
    name: "expired membership reads nothing",
    user: "frank",
    tenant: "acme",
    permission: p.project.read,
    row: saasProject("p1"),
    expected: { outcome: "denied" },
  },
  {
    name: "user without memberships reads nothing",
    user: "mallory",
    tenant: "acme",
    permission: p.project.read,
    row: saasProject("p1"),
    expected: { outcome: "denied" },
  },
  {
    name: "user without memberships and no tenant lists nothing",
    user: "mallory",
    permission: p.project.list,
    expected: { outcome: "denied" },
  },
  {
    name: "owner id user-2 updates its own row",
    user: "user-2",
    tenant: "org-1",
    permission: p.project.update,
    row: saasProject("n1"),
    expected: { outcome: "granted" },
  },
  {
    name: "id 2 is not id user-2",
    user: "2",
    tenant: "org-1",
    permission: p.project.update,
    row: saasProject("n1"),
    expected: { outcome: "denied" },
  },
  {
    name: "tenant-1 member cannot read an org-1 row",
    user: "tina",
    tenant: "tenant-1",
    permission: p.project.read,
    row: saasProject("o1"),
    expected: { outcome: "denied" },
  },
  {
    name: "team lead updates a team doc",
    user: "gina",
    tenant: "acme",
    permission: p.doc.update,
    row: saasDoc("d1"),
    expected: { outcome: "granted" },
    clientOutcome: "denied",
  },
  {
    name: "team lead cannot update a locked doc",
    user: "gina",
    tenant: "acme",
    permission: p.doc.update,
    row: saasDoc("d2"),
    expected: { outcome: "denied" },
  },
  {
    name: "team lead cannot update another team doc",
    user: "gina",
    tenant: "acme",
    permission: p.doc.update,
    row: saasDoc("d3"),
    expected: { outcome: "denied" },
  },
  {
    name: "viewer reads any doc in the org",
    user: "gina",
    tenant: "acme",
    permission: p.doc.read,
    row: saasDoc("d3"),
    expected: { outcome: "granted" },
  },
  {
    name: "project collaborator updates that project",
    user: "hank",
    tenant: "acme",
    permission: p.project.update,
    row: saasProject("p3"),
    expected: { outcome: "granted" },
  },
  {
    name: "project collaborator cannot update another project",
    user: "hank",
    tenant: "acme",
    permission: p.project.update,
    row: saasProject("p1"),
    expected: { outcome: "denied" },
  },
  {
    name: "admin revoking every key needs an owner approval",
    user: "alice",
    tenant: "acme",
    permission: p.apiKey.revokeAll,
    expected: { outcome: "approval-required" },
    client: false,
  },
  {
    name: "owner revokes every key directly",
    user: "carol",
    tenant: "acme",
    permission: p.apiKey.revokeAll,
    expected: { outcome: "granted" },
  },
  {
    name: "member cannot revoke keys",
    user: "bob",
    tenant: "acme",
    permission: p.apiKey.revokeAll,
    expected: { outcome: "denied" },
  },
  {
    name: "admin creates an api key within the quota",
    user: "alice",
    tenant: "acme",
    permission: p.apiKey.create,
    expected: { outcome: "granted" },
    client: false,
  },
  {
    name: "member cannot list members",
    user: "bob",
    tenant: "acme",
    permission: p.member.list,
    expected: { outcome: "denied" },
  },
  {
    name: "admin of the second org lists its members",
    user: "erin",
    tenant: "globex",
    permission: p.member.list,
    expected: { outcome: "granted" },
  },
  {
    name: "an agent acting for an admin without a delegation reaches nothing",
    user: "alice",
    tenant: "acme",
    actor: { id: "agent-1", kind: "agent" },
    permission: p.project.read,
    row: saasProject("p1"),
    expected: { outcome: "denied", reason: "no-delegation" },
  },
  {
    name: "an agent delegated read only reads",
    user: "alice",
    tenant: "acme",
    actor: { id: "agent-1", kind: "agent" },
    delegation: { scopes: [p.project.read.scope] },
    permission: p.project.read,
    row: saasProject("p1"),
    expected: { outcome: "granted" },
  },
  {
    name: "an agent delegated read only cannot update what the admin can",
    user: "alice",
    tenant: "acme",
    actor: { id: "agent-1", kind: "agent" },
    delegation: { scopes: [p.project.read.scope] },
    permission: p.project.update,
    row: saasProject("p2"),
    expected: { outcome: "denied", reason: "not-delegated" },
  },
  {
    name: "an admin past the daily api-key quota is refused",
    user: "alice",
    tenant: "acme",
    permission: p.apiKey.create,
    quotaUsed: SAAS_API_KEY_LIMIT,
    expected: { outcome: "denied", reason: "limit" },
    client: false,
  },
  {
    name: "the quota of one org does not spill into the other",
    user: "erin",
    tenant: "globex",
    permission: p.apiKey.create,
    quotaUsed: SAAS_API_KEY_LIMIT - 1,
    expected: { outcome: "granted" },
    client: false,
  },
  {
    name: "a team role held on the tenant membership grants nothing",
    user: "ivan",
    tenant: "acme",
    permission: p.doc.update,
    row: saasDoc("d1"),
    expected: { outcome: "denied" },
  },
  {
    name: "a tenant-1 member does not list org-1 projects",
    user: "tina",
    tenant: "org-1",
    permission: p.project.list,
    expected: { outcome: "denied" },
  },
  {
    name: "an org-1 member cannot create in tenant-1",
    user: "user-2",
    tenant: "tenant-1",
    permission: p.project.create,
    expected: { outcome: "denied" },
  },
  {
    name: "a tenant-1 member updates its own tenant-1 row only through tenant-1",
    user: "tina",
    tenant: "org-1",
    permission: p.project.update,
    row: saasProject("o1"),
    expected: { outcome: "denied" },
  },
  {
    name: "expired membership lists nothing",
    user: "frank",
    tenant: "acme",
    permission: p.project.list,
    expected: { outcome: "denied" },
  },
  {
    name: "expired membership creates nothing",
    user: "frank",
    tenant: "acme",
    permission: p.project.create,
    expected: { outcome: "denied" },
  },
  {
    name: "expired membership updates nothing",
    user: "frank",
    tenant: "acme",
    permission: p.project.update,
    row: saasProject("p1"),
    expected: { outcome: "denied" },
  },
  {
    name: "expired membership reads no doc",
    user: "frank",
    tenant: "acme",
    permission: p.doc.read,
    row: saasDoc("d1"),
    expected: { outcome: "denied" },
  },
]);
