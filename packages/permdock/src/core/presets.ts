import type {
  ActionList,
  ActionMeta,
  ResourceParent,
  ResourceRelationInput,
} from './permissions.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';

type ReadOnlyMeta = { readonly readOnly: true };
type DestructiveMeta = { readonly tags: readonly ['destructive'] };

type CrudActions = {
  readonly read: ReadOnlyMeta;
  readonly update: ActionMeta;
  readonly delete: DestructiveMeta;
};

type CrudCollection = {
  readonly create: ActionMeta;
  readonly list: ReadOnlyMeta;
};

type ReadableActions = { readonly read: ReadOnlyMeta };
type ReadableCollection = { readonly list: ReadOnlyMeta };
type WritableActions = {
  readonly read: ReadOnlyMeta;
  readonly update: ActionMeta;
};

const CRUD_ACTIONS: CrudActions = {
  read: { readOnly: true },
  update: {},
  delete: { tags: ['destructive'] as const },
};

const CRUD_COLLECTION: CrudCollection = {
  create: {},
  list: { readOnly: true },
};

const READABLE_ACTIONS: ReadableActions = {
  read: { readOnly: true },
};

const READABLE_COLLECTION: ReadableCollection = {
  list: { readOnly: true },
};

const WRITABLE_ACTIONS: WritableActions = {
  read: { readOnly: true },
  update: {},
};

const WRITABLE_COLLECTION: Record<never, never> = {};

type EmptyRecord = Record<never, never>;

type ActionNames<A extends ActionList | undefined> = A extends readonly string[]
  ? A[number] & string
  : A extends Record<string, ActionMeta>
    ? keyof A & string
    : never;

type ToActionRecord<A extends ActionList | undefined> = [
  ActionNames<A>,
] extends [never]
  ? EmptyRecord
  : { readonly [K in ActionNames<A>]: ActionMeta };

type OverlayMeta<Base extends ActionMeta, Extra extends ActionMeta> = Omit<
  Base,
  keyof Extra
> &
  Extra;

type MergeActionRecords<
  Base extends Record<string, ActionMeta>,
  Extra extends Record<string, ActionMeta>,
> = {
  readonly [K in keyof Base | keyof Extra]: K extends keyof Extra
    ? K extends keyof Base
      ? OverlayMeta<Base[K] & ActionMeta, Extra[K] & ActionMeta>
      : Extra[K] & ActionMeta
    : K extends keyof Base
      ? Base[K] & ActionMeta
      : never;
};

type PresetOptions<
  A extends ActionList | undefined = undefined,
  C extends ActionList | undefined = undefined,
> = {
  readonly id?: string;
  readonly parent?: ResourceParent;
  readonly relations?: Readonly<Record<string, ResourceRelationInput>>;
  readonly actions?: A;
  readonly collection?: C;
};

type PresetResult<
  BaseA extends Record<string, ActionMeta>,
  BaseC extends Record<string, ActionMeta>,
  A extends ActionList | undefined,
  C extends ActionList | undefined,
> = {
  readonly id?: string;
  readonly parent?: ResourceParent;
  readonly relations?: Readonly<Record<string, ResourceRelationInput>>;
  readonly actions: MergeActionRecords<BaseA, ToActionRecord<A>>;
  readonly collection?: MergeActionRecords<BaseC, ToActionRecord<C>>;
};

function isNameList(list: ActionList): list is readonly string[] {
  return Array.isArray(list);
}

function toRecord(list: ActionList | undefined): Record<string, ActionMeta> {
  if (list === undefined) {
    return {};
  }
  if (isNameList(list)) {
    const out: Record<string, ActionMeta> = {};
    for (const name of list) {
      out[name] = {};
    }
    return out;
  }
  return { ...list };
}

function mergeMeta(base: ActionMeta, extra: ActionMeta): ActionMeta {
  return compact<ActionMeta>({
    title: extra.title ?? base.title,
    description: extra.description ?? base.description,
    tags: extra.tags ?? base.tags,
    readOnly: extra.readOnly ?? base.readOnly,
  });
}

function mergeActionLists(
  base: Record<string, ActionMeta>,
  extra: ActionList | undefined,
): Record<string, ActionMeta> {
  const extraRecord = toRecord(extra);
  const out: Record<string, ActionMeta> = {};
  for (const [name, baseMeta] of Object.entries(base)) {
    const extraMeta = extraRecord[name];
    out[name] =
      extraMeta === undefined ? baseMeta : mergeMeta(baseMeta, extraMeta);
  }
  for (const [name, extraMeta] of Object.entries(extraRecord)) {
    if (Object.hasOwn(out, name)) {
      continue;
    }
    out[name] = extraMeta;
  }
  return freezeDeep(out);
}

function finishPreset<
  BaseA extends Record<string, ActionMeta>,
  BaseC extends Record<string, ActionMeta>,
  A extends ActionList | undefined,
  C extends ActionList | undefined,
>(
  baseActions: BaseA,
  baseCollection: BaseC,
  options: PresetOptions<A, C> | undefined,
): PresetResult<BaseA, BaseC, A, C> {
  const actions = mergeActionLists(
    baseActions,
    options?.actions,
  ) as MergeActionRecords<BaseA, ToActionRecord<A>>;
  const collection = mergeActionLists(
    baseCollection,
    options?.collection,
  ) as MergeActionRecords<BaseC, ToActionRecord<C>>;
  return compact({
    id: options?.id,
    parent: options?.parent,
    relations: options?.relations,
    actions,
    collection: Object.keys(collection).length === 0 ? undefined : collection,
  });
}

export function crud<
  const A extends ActionList | undefined = undefined,
  const C extends ActionList | undefined = undefined,
>(
  options?: PresetOptions<A, C>,
): PresetResult<typeof CRUD_ACTIONS, typeof CRUD_COLLECTION, A, C> {
  return finishPreset(CRUD_ACTIONS, CRUD_COLLECTION, options);
}

export function readable<
  const A extends ActionList | undefined = undefined,
  const C extends ActionList | undefined = undefined,
>(
  options?: PresetOptions<A, C>,
): PresetResult<typeof READABLE_ACTIONS, typeof READABLE_COLLECTION, A, C> {
  return finishPreset(READABLE_ACTIONS, READABLE_COLLECTION, options);
}

export function writable<
  const A extends ActionList | undefined = undefined,
  const C extends ActionList | undefined = undefined,
>(
  options?: PresetOptions<A, C>,
): PresetResult<typeof WRITABLE_ACTIONS, typeof WRITABLE_COLLECTION, A, C> {
  return finishPreset(WRITABLE_ACTIONS, WRITABLE_COLLECTION, options);
}
