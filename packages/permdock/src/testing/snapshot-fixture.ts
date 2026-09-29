import {
  createPermDock,
  type Policy,
  type Permission,
  type Snapshot,
} from '../index.ts';

export async function snapshotFixture(
  policy: Policy,
  subject: unknown,
  options: {
    readonly include?: readonly (
      | Permission
      | { readonly [key: string]: unknown }
    )[];
    readonly tenants?: 'all';
    readonly tenant?: string;
    readonly simulated?: boolean;
  } = {},
): Promise<Snapshot> {
  const instance = await createPermDock(
    policy,
    subject,
    options.tenant === undefined ? {} : { tenant: options.tenant },
  );
  const target = options.simulated === true ? instance.simulate({}) : instance;
  if (Array.isArray(target)) {
    throw new Error('PermDock: snapshotFixture expected a PermDock instance');
  }
  const snapshot =
    options.include === undefined && options.tenants === undefined
      ? target.snapshot()
      : target.snapshot({
          ...(options.include === undefined
            ? {}
            : { include: options.include }),
          ...(options.tenants === undefined
            ? {}
            : { tenants: options.tenants }),
        });
  if (typeof snapshot === 'string' || snapshot instanceof Promise) {
    throw new Error('PermDock: snapshotFixture expected a JSON snapshot');
  }
  return snapshot;
}
