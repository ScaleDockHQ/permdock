import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentPermDock } from "../agent/create.ts";
import type { ModelMap, ToolMap } from "../agent/types.ts";
import type { ApprovalStore } from "../approvals/index.ts";
import type { CustomRoleSource, Principal } from "../index.ts";
import type { SaasProject } from "./saas/permissions.ts";

import { memoryApprovalStore } from "../approvals/index.ts";
import { memoryCustomRoleSource } from "../index.ts";
import { AGENT_THROWING_ROW, AGENT_THROWING_USER } from "./agent-adapter.ts";
import { saasPermissions } from "./saas/permissions.ts";
import { saasPolicy } from "./saas/policy.ts";
import { saasCustomRoles, saasPrincipal, saasSeed } from "./saas/seed.ts";

/**
 * The server-side context of one call; the subject and tenant come from here,
 * never from arguments.
 */
export type AgentRuntimeContext = {
  /** `null` for a call with no authenticated user. */
  readonly user: string | null;
  readonly org: string;
};

export type AgentRuntimeOperation =
  | "project_read"
  | "project_search"
  | "api_keys_revoke_all";

export type AgentRuntimeModel = "standard" | "frontier";

/** What a mount wires into its `AgentPermDock`. */
export type AgentRuntimeDomain = {
  readonly policy: typeof saasPolicy;
  /**
   * The principal for `user` with the plans of `org`, or `null`. Throws for
   * `AGENT_THROWING_USER`.
   */
  readonly subject: (user: string | null, org: string) => Principal | null;
  /**
   * `project_read` loads the row named by `args.id`; `project_search` has a
   * `results` permission; `api_keys_revoke_all` needs approval.
   */
  readonly operations: ToolMap & {
    readonly [K in AgentRuntimeOperation]: ToolMap[K];
  };
  /** `standard` for any reader, `frontier` for an admin on the `pro` plan. */
  readonly models: ModelMap & {
    readonly [K in AgentRuntimeModel]: ModelMap[K];
  };
  readonly customRoles: CustomRoleSource;
  readonly store: ApprovalStore;
};

export type AgentRuntimeMounted = {
  readonly agent: AgentPermDock<AgentRuntimeContext>;
  readonly close?: () => Promise<void> | void;
};

export type AgentRuntimeScenarioName =
  | "granted"
  | "denied"
  | "cross-tenant"
  | "anonymous"
  | "subject-throws"
  | "loader-throws"
  | "missing-row"
  | "approval-required"
  | "unmapped-operation"
  | "allowed-operations"
  | "model-gate"
  | "permitted-models"
  | "results-filter"
  | "gateway-options";

export type AgentRuntimeOptions = {
  readonly name: string;
  readonly mount: (
    domain: AgentRuntimeDomain,
  ) => AgentRuntimeMounted | Promise<AgentRuntimeMounted>;
  /** Scenarios the runtime cannot express, each with a reason. */
  readonly skip?: Readonly<Partial<Record<AgentRuntimeScenarioName, string>>>;
};

type OperationScenario = {
  readonly name: AgentRuntimeScenarioName;
  readonly title: string;
  readonly context: AgentRuntimeContext;
  readonly operation: string;
  readonly input: unknown;
  readonly expected: "granted" | "denied" | "approval-required";
};

const alice: AgentRuntimeContext = { user: "alice", org: "acme" };
const erin: AgentRuntimeContext = { user: "erin", org: "globex" };
const mallory: AgentRuntimeContext = { user: "mallory", org: "acme" };

const OPERATIONS: readonly OperationScenario[] = [
  {
    name: "granted",
    title: "grants a member reading a project in their org",
    context: alice,
    operation: "project_read",
    input: { id: "p1" },
    expected: "granted",
  },
  {
    name: "denied",
    title: "denies a user with no membership",
    context: mallory,
    operation: "project_read",
    input: { id: "p1" },
    expected: "denied",
  },
  {
    name: "cross-tenant",
    title: "denies a row from another org",
    context: alice,
    operation: "project_read",
    input: { id: "g1" },
    expected: "denied",
  },
  {
    name: "anonymous",
    title: "denies a call with no user",
    context: { user: null, org: "acme" },
    operation: "project_read",
    input: { id: "p1" },
    expected: "denied",
  },
  {
    name: "subject-throws",
    title: "denies when the subject resolver throws",
    context: { user: AGENT_THROWING_USER, org: "acme" },
    operation: "project_read",
    input: { id: "p1" },
    expected: "denied",
  },
  {
    name: "loader-throws",
    title: "denies when the row loader throws",
    context: alice,
    operation: "project_read",
    input: { id: AGENT_THROWING_ROW },
    expected: "denied",
  },
  {
    name: "missing-row",
    title: "denies when the row does not exist",
    context: alice,
    operation: "project_read",
    input: { id: "missing" },
    expected: "denied",
  },
  {
    name: "approval-required",
    title: "asks for approval before revoking every API key",
    context: alice,
    operation: "api_keys_revoke_all",
    input: {},
    expected: "approval-required",
  },
  {
    name: "unmapped-operation",
    title: "denies an operation the map does not name",
    context: alice,
    operation: "drop_database",
    input: {},
    expected: "denied",
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

function createDomain(): AgentRuntimeDomain {
  return {
    policy: saasPolicy,
    subject: (user, org) => {
      if (user === AGENT_THROWING_USER) {
        throw new Error("session store unavailable");
      }
      return user === null ? null : saasPrincipal(user, org);
    },
    operations: {
      project_read: {
        permission: saasPermissions.project.read,
        data: loadProject,
      },
      project_search: {
        permission: saasPermissions.project.list,
        results: saasPermissions.project.read,
      },
      api_keys_revoke_all: { permission: saasPermissions.apiKey.revokeAll },
    },
    models: {
      standard: saasPermissions.integration.read,
      frontier: saasPermissions.analytics.read,
    },
    customRoles: memoryCustomRoleSource(saasCustomRoles),
    store: memoryApprovalStore(),
  };
}

function projects(...ids: readonly string[]): readonly SaasProject[] {
  return ids.flatMap((id) => saasSeed.projects.filter((row) => row.id === id));
}

/**
 * Runs the `AgentPermDock` contract against a runtime: operations decided by
 * name, the listing hint, the model gate, the results filter and gateway
 * attribution. Every failure denies, and no method throws.
 */
export function testAgentRuntime(options: AgentRuntimeOptions): void {
  describe(`${options.name}: agent runtime contract`, () => {
    const domain = createDomain();
    let mounted: AgentRuntimeMounted;

    beforeAll(async () => {
      mounted = await options.mount(domain);
    });

    afterAll(async () => {
      await mounted.close?.();
    });

    const agent = (): AgentPermDock<AgentRuntimeContext> => mounted.agent;

    const scenario = (
      name: AgentRuntimeScenarioName,
      title: string,
      run: () => Promise<void>,
    ): void => {
      const reason = options.skip?.[name];
      it.skipIf(reason !== undefined)(
        reason === undefined ? title : `${title} (${reason})`,
        run,
      );
    };

    for (const entry of OPERATIONS) {
      scenario(entry.name, entry.title, async () => {
        const verdict = await agent().decideOperation(
          entry.operation,
          entry.input,
          entry.context,
        );
        expect(verdict.outcome).toBe(entry.expected);
      });
    }

    scenario(
      "allowed-operations",
      "lists the operations a subject could be granted, and none for a stranger",
      async () => {
        const listed = await agent().allowedOperations(alice);
        expect(listed.has("project_read")).toBe(true);
        expect(listed.has("drop_database")).toBe(false);
        expect([...(await agent().allowedOperations(mallory))]).toStrictEqual(
          [],
        );
      },
    );

    scenario(
      "model-gate",
      "grants a model by its permission and denies one the map does not name",
      async () => {
        expect((await agent().decideModel("frontier", erin)).outcome).toBe(
          "granted",
        );
        expect((await agent().decideModel("frontier", alice)).outcome).toBe(
          "denied",
        );
        expect((await agent().decideModel("unlisted", erin)).outcome).toBe(
          "denied",
        );
        expect(
          (
            await agent().decideModel("standard", {
              user: AGENT_THROWING_USER,
              org: "acme",
            })
          ).outcome,
        ).toBe("denied");
      },
    );

    scenario(
      "permitted-models",
      "returns the granted models in declaration order",
      async () => {
        expect(await agent().permittedModels(erin)).toStrictEqual([
          "standard",
          "frontier",
        ]);
        expect(await agent().permittedModels(alice)).toStrictEqual([
          "standard",
        ]);
        expect(await agent().permittedModels(mallory)).toStrictEqual([]);
      },
    );

    scenario(
      "results-filter",
      "keeps the rows the results permission grants, and none for an unknown operation",
      async () => {
        const rows = projects("p1", "g1", "p2");
        expect(
          (await agent().filterResults("project_search", rows, alice)).map(
            (row) => row.id,
          ),
        ).toStrictEqual(["p1", "p2"]);
        expect(
          await agent().filterResults("project_search", rows, mallory),
        ).toStrictEqual([]);
        expect(
          await agent().filterResults("drop_database", rows, alice),
        ).toStrictEqual([]);
      },
    );

    scenario(
      "gateway-options",
      "attributes gateway usage to the principal, and to nobody for an anonymous call",
      async () => {
        const attributed = await agent().gatewayOptions(alice);
        expect(attributed.gateway.user).toBe("alice");
        const anonymous = await agent().gatewayOptions({
          user: null,
          org: "acme",
        });
        expect(anonymous.gateway.user).toBeUndefined();
      },
    );
  });
}
