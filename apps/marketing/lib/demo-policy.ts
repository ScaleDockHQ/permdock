import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  describe,
  resource,
  role,
  type Decision,
  type DecideOptions,
  type DecisionDescription,
  type PermDock,
} from 'permdock';

const demoPermissions = definePermissions({
  post: resource({
    id: 'id',
    actions: ['read', 'update', 'delete', 'publish'],
    collection: ['create', 'list'],
  }),
});

export const DEMO_ROLES = ['member', 'admin'] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

export const DEMO_ACTIONS = [
  'read',
  'update',
  'delete',
  'publish',
  'create',
  'list',
] as const;
export type DemoAction = (typeof DEMO_ACTIONS)[number];

const member = role('member', [
  allow(demoPermissions.post.read),
  allow(demoPermissions.post.list),
  allow(demoPermissions.post.create),
  allow(demoPermissions.post.update),
]);

const admin = role('admin', [
  allow(demoPermissions.post.read),
  allow(demoPermissions.post.list),
  allow(demoPermissions.post.create),
  allow(demoPermissions.post.update),
  allow(demoPermissions.post.delete),
  allow(demoPermissions.post.publish, { approval: 'human' }),
]);

function demoSubject(user: unknown): { id: string; roles: readonly string[] } {
  if (
    user !== null &&
    typeof user === 'object' &&
    'id' in user &&
    typeof user.id === 'string' &&
    'roles' in user &&
    Array.isArray(user.roles)
  ) {
    return {
      id: user.id,
      roles: user.roles.filter(
        (name): name is string => typeof name === 'string',
      ),
    };
  }
  return { id: 'anon', roles: [] };
}

const policy = definePolicy(demoPermissions, {
  roles: [member, admin],
  subject: demoSubject,
});

// The demo prerenders, so it cannot read the wall clock; no demo grant expires.
const DEMO_OPTIONS: DecideOptions = { now: 1_767_225_600 };

function demoDock(roleName: DemoRole): PermDock {
  const created = createPermDock(policy, {
    id: 'demo-user',
    roles: [roleName],
  });
  if (created instanceof Promise) {
    throw new TypeError('marketing demo subject is synchronous');
  }
  return created;
}

export type DemoDecisionView = {
  readonly outcome: Decision['outcome'];
  readonly description: DecisionDescription;
  readonly permission: string;
};

export function demoDecide(
  roleName: DemoRole,
  action: DemoAction,
): DemoDecisionView {
  const dock = demoDock(roleName);
  const post = { id: 'post-1' };
  let decision: Decision;
  let permissionKey: string;
  switch (action) {
    case 'read':
      decision = dock.decide(demoPermissions.post.read, post, DEMO_OPTIONS);
      permissionKey = demoPermissions.post.read.key;
      break;
    case 'update':
      decision = dock.decide(demoPermissions.post.update, post, DEMO_OPTIONS);
      permissionKey = demoPermissions.post.update.key;
      break;
    case 'delete':
      decision = dock.decide(demoPermissions.post.delete, post, DEMO_OPTIONS);
      permissionKey = demoPermissions.post.delete.key;
      break;
    case 'publish':
      decision = dock.decide(demoPermissions.post.publish, post, DEMO_OPTIONS);
      permissionKey = demoPermissions.post.publish.key;
      break;
    case 'create':
      decision = dock.decide(
        demoPermissions.post.create,
        undefined,
        DEMO_OPTIONS,
      );
      permissionKey = demoPermissions.post.create.key;
      break;
    case 'list':
      decision = dock.decide(
        demoPermissions.post.list,
        undefined,
        DEMO_OPTIONS,
      );
      permissionKey = demoPermissions.post.list.key;
      break;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
  return {
    outcome: decision.outcome,
    description: describe(decision),
    permission: permissionKey,
  };
}
