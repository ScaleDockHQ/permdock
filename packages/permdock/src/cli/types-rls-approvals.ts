/** `rls.approvals.managers`: one row per user and manager. */
/** Column names of the table `rls.approvals.tenantPolicies` writes. */
export type RlsApprovalPolicyColumns = {
  readonly id?: string;
  readonly tenant?: string;
  readonly name?: string;
  readonly body?: string;
  readonly enabled?: string;
  readonly createdAt?: string;
};

export type RlsApprovalPolicies = {
  /** The permission key whose holders in a tenant edit its policies. */
  readonly manage: string;
  /**
   * The table, as `table` or `schema.table`; the helper schema's
   * `approval_policies` by default. It is created when missing.
   */
  readonly table?: string;
  /**
   * The function `tableApprovalPolicySource` reads, in the helper schema;
   * `permdock_approval_policies_for` by default. Pass the same name as
   * `function` to the source.
   */
  readonly function?: string;
  readonly columns?: RlsApprovalPolicyColumns;
  /**
   * Where the `ApprovalPolicy` sits inside the body column, as object keys; the
   * column itself by default. The constraint requires an `approval` key there.
   */
  readonly path?: readonly string[];
};

export type RlsApprovalManagers = {
  /** `table` or `schema.table`. */
  readonly table: string;
  /** The column holding the user's id. */
  readonly user: string;
  /** The column holding the id of that user's manager. */
  readonly manager: string;
  /**
   * The column holding the tenant each edge belongs to. Required when the
   * policy has a tenant scope: both walks keep only the edges of the request's
   * tenant, so the table or view must expose it.
   */
  readonly tenant?: string;
};

/**
 * `rls.approvals` on a table the app already has: the store functions keep each
 * request's body in `body` and its token in `token` (both added when missing)
 * and read every field from the body; `mirror` copies request fields into the
 * app's own columns on each write, converted to their types.
 */
export type RlsApprovalsAdopt = {
  readonly store?: boolean;
  /**
   * `table` or `schema.table`. Without it the store is the generated
   * `approval_requests`.
   */
  readonly table?: string;
  /**
   * Add `approval_delegations`, the out-of-office covers a user writes for
   * themselves, and the four-argument `permdock_is_approver` that answers for a
   * delegate inside an active cover. `tableApprovalDelegationSource` reads the
   * same rows for `approvalsHandler`. Off by default.
   */
  readonly delegations?: boolean;
  /**
   * Add `approval_policies`, the approval requirements a tenant keeps as data,
   * and `permdock_approval_policies_for`, which `tableApprovalPolicySource`
   * reads. A holder of the `manage` permission key in a tenant writes that
   * tenant's rows; rows with `tenant` null are platform floors, written only by
   * the table owner. Off by default.
   */
  readonly tenantPolicies?: RlsApprovalPolicies;
  /**
   * The app's table that names each user's manager, so `manager()` approvers
   * match in SQL: `permdock_manages` walks it and the four-argument
   * `permdock_is_approver` calls it. Off by default.
   */
  readonly managers?: RlsApprovalManagers;
  /** A text column unique per request. Default `token`. */
  readonly token?: string;
  /** A jsonb column holding the `ApprovalRequest`. Default `body`. */
  readonly body?: string;
  readonly open?: "insert" | "attach";
  readonly schema?: string;
  /** Request fields copied into the app's columns, field to column. */
  readonly mirror?: {
    readonly status?: string;
    readonly permission?: string;
    readonly tenant?: string;
    readonly principalId?: string;
    readonly actorId?: string;
    readonly session?: string;
    readonly approvals?: string;
    readonly createdAt?: string;
    readonly expiresAt?: string;
    readonly resolvedAt?: string;
    readonly resolvedBy?: string;
    readonly consumedAt?: string;
  };
};

export type RlsApiKeys = {
  readonly claim?: string;
  readonly scopes?: string;
  readonly tenant?: string;
  readonly roles?: string;
  readonly serviceRoles?: readonly string[];
};
