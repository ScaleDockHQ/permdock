import type { Denial, Obligation } from "../decision.ts";
import type { Evaluate } from "../evaluation-alternatives.ts";
import type { Tracer } from "../evaluation-trace.ts";
import type { EvalEnv } from "../events.ts";
import type { DecideOptions } from "../permdock.ts";
import type { Permission, ResourceNode } from "../permission-types.ts";
import type { Grant, Policy } from "../policy-types.ts";
import type { expandRoleNames } from "../role-loading.ts";
import type { Scope } from "../scopes.ts";
import type { CustomRole, Membership, Subject } from "../subject.ts";
import type { ResourceRoleWalk } from "../tenancy.ts";

export type Rows = { readonly current: unknown; readonly next: unknown };

export type Allow = {
  readonly grant: Grant;
  readonly membership?: Membership;
  readonly obligations?: readonly Obligation[];
  readonly breakGlass?: true;
};

export type Candidate = {
  readonly grant: Grant;
  readonly custom?: CustomRole;
};

export type BreakGlass = {
  readonly grant: Grant | undefined;
  readonly obligations: readonly Obligation[];
  readonly overrides: ReadonlySet<string>;
  readonly denial: Denial | undefined;
};

export type HeldRoles = {
  readonly global: ReturnType<typeof expandRoleNames>;
  readonly matching: ReadonlySet<string>;
  readonly denials: Denial[];
};

/** The inputs every stage of one `evaluate` call reads. */
export type EvaluationCall = {
  readonly policy: Policy;
  readonly given: Subject;
  readonly subject: Subject;
  readonly permission: Permission;
  readonly options: DecideOptions;
  readonly env: EvalEnv;
  readonly now: number;
  readonly resource: ResourceNode | undefined;
  readonly tracer: Tracer | undefined;
  /** `evaluate` itself, which alternatives and inherited verdicts call again. */
  readonly evaluate: Evaluate;
};

/** One call after validation: its rows, held roles, and the denials and allows the grant stages collect. */
export type EvaluationState = EvaluationCall &
  Rows & {
    readonly scopes: readonly Scope[];
    readonly declared: ReadonlySet<string>;
    readonly roles: HeldRoles;
    readonly purposes: readonly string[];
    readonly walkRole: ResourceRoleWalk | undefined;
    readonly denials: Denial[];
    readonly allows: Allow[];
  };
