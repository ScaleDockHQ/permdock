import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ToolMap } from "../agent/types.ts";
import type { ApprovalStore } from "../approvals/index.ts";
import type { Principal, RoleSource } from "../index.ts";
import type { SaasProject } from "./saas/permissions.ts";

import { memoryApprovalStore } from "../approvals/index.ts";
import { memoryRoleSource } from "../index.ts";
import { saasPermissions } from "./saas/permissions.ts";
import { saasPolicy } from "./saas/policy.ts";
import { saasCustomRoles, saasPrincipal, saasSeed } from "./saas/seed.ts";

/** The user whose subject resolver throws. */
export const AGENT_THROWING_USER = "throws";
/** The project id whose loader throws. */
export const AGENT_THROWING_ROW = "throws";

export type AgentToolName = "project_read" | "api_keys_revoke_all";

/**
 * What a mount wires into its adapter. The subject and the tenant come from
 * the server-side context the mount builds for each call, never from the
 * tool arguments.
 */
export type AgentScenarioDomain = {
  readonly policy: typeof saasPolicy;
  /**
   * The principal for `user` with the plans of `org`, or `null` for an
   * anonymous call. Throws for `AGENT_THROWING_USER`.
   */
  readonly subject: (user: string | null, org: string) => Principal | null;
  /**
   * `project_read` loads the row named by `args.id`: `null` for an unknown
   * id, a throw for `AGENT_THROWING_ROW`. `api_keys_revoke_all` needs
   * approval.
   */
  readonly tools: ToolMap & { readonly [K in AgentToolName]: ToolMap[K] };
  readonly customRoles: RoleSource;
  readonly store: ApprovalStore;
};

export type AgentCall = {
  /** `null` for a call with no authenticated user. */
  readonly user: string | null;
  readonly org: string;
  readonly tool: AgentToolName;
  readonly args: { readonly id?: string };
};

export type AgentOutcome = "granted" | "denied" | "approval-required";

export type AgentMounted = {
  /** Runs one tool call through the adapter's own entry and reports its outcome. */
  readonly call: (call: AgentCall) => Promise<AgentOutcome>;
  readonly close?: () => Promise<void> | void;
};

export type AgentScenarioName =
  | "granted"
  | "denied"
  | "cross-tenant"
  | "anonymous"
  | "subject-throws"
  | "loader-throws"
  | "missing-row"
  | "approval-required";

export type AgentAdapterOptions = {
  readonly name: string;
  readonly mount: (
    domain: AgentScenarioDomain,
  ) => AgentMounted | Promise<AgentMounted>;
  /** Scenarios the adapter cannot express, each with a reason. */
  readonly skip?: Readonly<Partial<Record<AgentScenarioName, string>>>;
};

type Scenario = {
  readonly name: AgentScenarioName;
  readonly title: string;
  readonly call: AgentCall;
  readonly expected: AgentOutcome;
};

const SCENARIOS: readonly Scenario[] = [
  {
    name: "granted",
    title: "grants a member reading a project in their org",
    call: {
      user: "alice",
      org: "acme",
      tool: "project_read",
      args: { id: "p1" },
    },
    expected: "granted",
  },
  {
    name: "denied",
    title: "denies a user with no membership",
    call: {
      user: "mallory",
      org: "acme",
      tool: "project_read",
      args: { id: "p1" },
    },
    expected: "denied",
  },
  {
    name: "cross-tenant",
    title: "denies a row from another org",
    call: {
      user: "alice",
      org: "acme",
      tool: "project_read",
      args: { id: "g1" },
    },
    expected: "denied",
  },
  {
    name: "anonymous",
    title: "denies a call with no user",
    call: { user: null, org: "acme", tool: "project_read", args: { id: "p1" } },
    expected: "denied",
  },
  {
    name: "subject-throws",
    title: "denies when the subject resolver throws",
    call: {
      user: AGENT_THROWING_USER,
      org: "acme",
      tool: "project_read",
      args: { id: "p1" },
    },
    expected: "denied",
  },
  {
    name: "loader-throws",
    title: "denies when the row loader throws",
    call: {
      user: "alice",
      org: "acme",
      tool: "project_read",
      args: { id: AGENT_THROWING_ROW },
    },
    expected: "denied",
  },
  {
    name: "missing-row",
    title: "denies when the row does not exist",
    call: {
      user: "alice",
      org: "acme",
      tool: "project_read",
      args: { id: "missing" },
    },
    expected: "denied",
  },
  {
    name: "approval-required",
    title: "asks for approval before revoking every API key",
    call: { user: "alice", org: "acme", tool: "api_keys_revoke_all", args: {} },
    expected: "approval-required",
  },
];

function loadProject(args: unknown): SaasProject | null {
  // SAFETY: read only from a non-null object; id is compared, never trusted as a type.
  const id =
    typeof args === "object" && args !== null
      ? (args as { readonly id?: unknown }).id
      : undefined;
  if (id === AGENT_THROWING_ROW) {
    throw new Error("project store unavailable");
  }
  return saasSeed.projects.find((row) => row.id === id) ?? null;
}

function createDomain(): AgentScenarioDomain {
  return {
    policy: saasPolicy,
    subject: (user, org) => {
      if (user === AGENT_THROWING_USER) {
        throw new Error("session store unavailable");
      }
      return user === null ? null : saasPrincipal(user, org);
    },
    tools: {
      project_read: {
        permission: saasPermissions.project.read,
        data: loadProject,
      },
      api_keys_revoke_all: { permission: saasPermissions.apiKey.revokeAll },
    },
    customRoles: memoryRoleSource(saasCustomRoles),
    store: memoryApprovalStore(),
  };
}

/**
 * Runs the same tool calls through an agent adapter: a grant, the denials an
 * attacker or an outage produces, and an approval. Every failure denies.
 */
export function testAgentAdapter(options: AgentAdapterOptions): void {
  describe(`${options.name}: agent adapter scenarios`, () => {
    const domain = createDomain();
    let mounted: AgentMounted;

    beforeAll(async () => {
      mounted = await options.mount(domain);
    });

    afterAll(async () => {
      await mounted.close?.();
    });

    const outcomeOf = (call: AgentCall): Promise<AgentOutcome> =>
      mounted.call(call);

    for (const scenario of SCENARIOS) {
      const reason = options.skip?.[scenario.name];
      it.skipIf(reason !== undefined)(
        reason === undefined ? scenario.title : `${scenario.title} (${reason})`,
        async () => {
          expect(await outcomeOf(scenario.call)).toBe(scenario.expected);
        },
      );
    }
  });
}
