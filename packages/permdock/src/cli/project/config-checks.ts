import type { OperationMap } from "../../core/operations.ts";
import type { PermissionTree } from "../../core/permission-types.ts";
import type { Policy } from "../../core/policy-types.ts";
import type {
  ActionNameOf,
  PermissionKeyOf,
  ResourceNameOf,
  ScopeNameOf,
} from "../../core/type-helpers.ts";
import type { PermDockConfig } from "../types.ts";

/**
 * What `defineConfig` accepts: `policy`, `permissions` and `operations` take
 * the imported value or its module path. A value types the keys below it; the
 * CLI reads it from the module the config file imports it from.
 */
export type PermDockConfigInput = Omit<
  PermDockConfig,
  "policy" | "permissions" | "operations"
> & {
  readonly policy?: string | Policy;
  readonly permissions?: string | PermissionTree;
  readonly operations?: string | OperationMap;
};

type At<T, K extends PropertyKey> = T extends { readonly [P in K]?: infer V }
  ? NonNullable<V>
  : never;

type KeysAt<T, K extends PropertyKey> = keyof At<T, K> & string;

/** `never` on every key of `T` outside `Allowed`, so a stray key fails. */
type Only<Keys extends string, Allowed> = {
  readonly [K in Exclude<Keys, Allowed>]?: never;
};

/** The pattern itself when a `{name}` segment names no scope in `S`. */
type StrayPlaceholder<
  Pattern extends string,
  S,
> = Pattern extends `${string}{${infer Name}}${infer Rest}`
  ? Name extends S
    ? StrayPlaceholder<Rest, S>
    : Pattern
  : never;

type BadTopics<Topics extends string, S> = {
  readonly [
    K in Topics as StrayPlaceholder<K, S> extends never ? never : K
  ]?: never;
};

type KeepEntry<P> = PermissionKeyOf<P> | { readonly key: string };

type BucketChecks<C, P> = {
  readonly [B in KeysAt<At<At<C, "rls">, "storage">, "buckets">]?: {
    readonly scope?: ScopeNameOf<P>;
  };
};

type SuspensionChecks<C, P> = {
  readonly scopes?: Only<
    KeysAt<At<At<C, "rls">, "suspension">, "scopes">,
    ScopeNameOf<P>
  > & {
    readonly [S in ScopeNameOf<P>]?: {
      readonly keep?: readonly KeepEntry<P>[];
    };
  };
  readonly memberships?: { readonly keep?: readonly KeepEntry<P>[] };
};

type RlsChecks<C, P> = {
  readonly tables?: Only<KeysAt<At<C, "rls">, "tables">, ResourceNameOf<P>>;
  readonly scopeTypes?: Only<
    KeysAt<At<C, "rls">, "scopeTypes">,
    ScopeNameOf<P>
  >;
  readonly actions?: Only<KeysAt<At<C, "rls">, "actions">, ActionNameOf<P>>;
  readonly memberships?: {
    readonly scopes?: Only<
      KeysAt<At<At<C, "rls">, "memberships">, "scopes">,
      ScopeNameOf<P>
    >;
  };
  readonly suspension?: SuspensionChecks<C, P>;
  readonly customRoleWrites?: {
    readonly requires?: "manageRoles" | readonly PermissionKeyOf<P>[];
  };
  readonly realtime?: {
    readonly topics?: BadTopics<
      KeysAt<At<At<C, "rls">, "realtime">, "topics">,
      ScopeNameOf<P>
    >;
  };
  readonly storage?: { readonly buckets?: BucketChecks<C, P> };
};

type PolicyOf<C> = C extends { readonly policy: infer P }
  ? P extends Policy
    ? P
    : never
  : never;

/**
 * The checks a policy value adds to its config: resource, scope, action and
 * permission names in the keys that name them, and `{scope}` placeholders in
 * Realtime topics. Without a policy value, nothing.
 */
export type ConfigChecks<C> = [PolicyOf<C>] extends [never]
  ? unknown
  : {
      readonly rls?: RlsChecks<C, PolicyOf<C>>;
      readonly powersync?: {
        readonly resources?: readonly ResourceNameOf<PolicyOf<C>>[];
        readonly action?: ActionNameOf<PolicyOf<C>>;
      };
    };
