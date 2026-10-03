import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

export type User = {
  readonly id: string;
  readonly roles: readonly string[];
};

const developer = role("developer", [
  allow(permissions.deploy.read),
  allow(permissions.deploy.run, { where: { env: "staging" } }),
  allow(permissions.deploy.rollback, { where: { env: "staging" } }),
]);

const release = role("release", [
  ...developer.grants,
  allow(permissions.deploy.run, { approval: { distinct: false } }),
  allow(permissions.deploy.rollback, { approval: { distinct: false } }),
]);

export const policy = definePolicy(permissions, {
  roles: [developer, release],
  subject: (user: User | null) =>
    user === null ? null : { id: user.id, roles: user.roles },
  validate: "never",
});

export const developerUser: User = { id: "u1", roles: ["developer"] };
export const releaseUser: User = { id: "u2", roles: ["release"] };
