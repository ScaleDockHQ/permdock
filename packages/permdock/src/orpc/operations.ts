import type { AnySchema, MetaPlugin, Procedure, Schema } from "@orpc/server";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { os } from "@orpc/server";

import type { Operation, OperationInput } from "../core/operations.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PolicyVocabulary } from "../core/policy-types.ts";
import type {
  OrpcMiddleware,
  OrpcMiddlewareOpts,
  OrpcProtectOptions,
} from "./create.ts";

export type OperationProcedureContext<
  TCtx extends object,
  V extends PolicyVocabulary = PolicyVocabulary,
> = TCtx & {
  readonly permdock: PermDock<V>;
  /** The row the operation's `data` loader read; `undefined` without one. */
  readonly permdockData?: unknown;
};

export type OperationRoute<
  TCtx extends object,
  TInput,
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  readonly handler: (opts: {
    readonly input: TInput;
    readonly context: OperationProcedureContext<TCtx, V>;
  }) => unknown;
} & ([TInput] extends [undefined]
  ? { readonly input?: StandardSchemaV1<unknown, TInput> }
  : {
      /** Required: the operation's `data` loader never sees raw input. */
      readonly input: StandardSchemaV1<unknown, TInput>;
    });

export type OperationRoutes<
  TOperations extends Readonly<Record<string, Operation>>,
  TCtx extends object,
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  readonly [TName in keyof TOperations]: OperationRoute<
    TCtx,
    OperationInput<TOperations[TName]>,
    V
  >;
};

export type OperationsRouterOptions = {
  /** oRPC meta plugins per operation, such as `openapi()` from `@orpc/openapi`. */
  readonly meta?: (
    operation: Operation,
    // oxlint-disable-next-line typescript/no-generated-empty-object-type -- oRPC's own "no errors" type
  ) => readonly MetaPlugin<AnySchema, AnySchema, Record<never, never>>[];
};

type InputSchemaOf<TRoute> = TRoute extends {
  readonly input: infer TSchema extends AnySchema;
}
  ? TSchema
  : Schema<undefined>;

type OutputOf<TRoute> = TRoute extends {
  readonly handler: (...args: never[]) => infer TResult;
}
  ? Awaited<TResult>
  : never;

export type OperationsRouter<TCtx extends object, TRoutes> = {
  readonly [TName in keyof TRoutes]: Procedure<
    TCtx,
    // oxlint-disable-next-line typescript/no-explicit-any -- oRPC's injected-context slot; callers never read it
    any,
    InputSchemaOf<TRoutes[TName]>,
    Schema<OutputOf<TRoutes[TName]>>,
    // oxlint-disable-next-line typescript/no-generated-empty-object-type -- oRPC's own "no errors" type
    Record<never, never>
  >;
};

export type OperationsRouterOf<
  TCtx extends object,
  V extends PolicyVocabulary,
> = <
  TOperations extends Readonly<Record<string, Operation>>,
  const TRoutes extends OperationRoutes<TOperations, TCtx, V>,
>(
  operations: TOperations,
  routes: TRoutes,
  options?: OperationsRouterOptions,
) => OperationsRouter<TCtx, TRoutes>;

type RouterDeps<TCtx extends object, V extends PolicyVocabulary> = {
  readonly middleware: () => OrpcMiddleware<TCtx, unknown, V>;
  readonly protect: (
    permission: Permission | null,
    data?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: OrpcProtectOptions<TCtx>,
  ) => OrpcMiddleware<TCtx, unknown, V>;
};

/**
 * The part of oRPC's builder the router chains; its generics only type app
 * code.
 */
type ProcedureBuilder = {
  readonly meta: (...plugins: readonly unknown[]) => ProcedureBuilder;
  readonly use: (middleware: unknown) => ProcedureBuilder;
  readonly input: (schema: unknown) => ProcedureBuilder;
  readonly handler: (
    handler: (opts: {
      readonly input: unknown;
      readonly context: unknown;
    }) => unknown,
  ) => unknown;
};

// SAFETY: `os` is oRPC's root builder, which has every method ProcedureBuilder names.
const root = os as unknown as ProcedureBuilder;

type AnyRoute = {
  readonly input?: unknown;
  readonly handler: (opts: {
    readonly input: unknown;
    readonly context: OperationProcedureContext<object>;
  }) => unknown;
};

function routeOf(name: string, value: unknown): AnyRoute {
  const handler: unknown =
    value !== null && typeof value === "object"
      ? Reflect.get(value, "handler")
      : undefined;
  if (typeof handler !== "function") {
    throw new TypeError(
      `operationsRouter: the route for operation "${name}" needs a handler function.`,
    );
  }
  // SAFETY: the route is an object whose handler is a function; oRPC reads its input as a Standard Schema.
  return value as AnyRoute;
}

/**
 * Builds one oRPC procedure per operation: `middleware()`, the route's `input`
 * schema, then `protect(operation.permission, operation.data)`. Throws at
 * definition time when a route names no operation, an operation has no route,
 * or an operation with `data` has no `input` schema.
 */
export function operationsRouterOf<
  TCtx extends object,
  V extends PolicyVocabulary,
>(deps: RouterDeps<TCtx, V>): OperationsRouterOf<TCtx, V> {
  return (operations, routes, options = {}) => {
    for (const name of Object.keys(routes)) {
      if (!Object.hasOwn(operations, name)) {
        throw new TypeError(
          `operationsRouter: "${name}" is not an operation passed to operationsRouter.`,
        );
      }
    }
    const router: Record<string, unknown> = {};
    for (const [name, operation] of Object.entries(operations)) {
      if (!Object.hasOwn(routes, name)) {
        throw new TypeError(
          `operationsRouter: operation "${name}" has no route.`,
        );
      }
      const route = routeOf(name, Reflect.get(routes, name));
      const load = operation.data;
      if (load !== undefined && route.input === undefined) {
        throw new TypeError(
          `operationsRouter: operation "${name}" loads a row from its input, so its route needs an input schema.`,
        );
      }
      const base = root
        .meta(...(options.meta?.(operation) ?? []))
        .use(deps.middleware());
      router[name] = (
        route.input === undefined ? base : base.input(route.input)
      )
        .use(
          deps.protect(
            operation.permission,
            load === undefined
              ? undefined
              : (opts): unknown => load(opts.input),
          ),
        )
        .handler(({ input, context }): unknown =>
          route.handler({
            input,
            // SAFETY: middleware() and protect() ran first, so the context carries permdock and permdockData.
            context: context as OperationProcedureContext<object>,
          }),
        );
    }
    // SAFETY: router holds one procedure per route key, built with that route's input schema and handler.
    return router as OperationsRouter<TCtx, typeof routes>;
  };
}
