import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/cli/types.ts";

import { scanSources } from "../../src/cli/scan.ts";
import { project, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const KNOWN = new Set(["post.read", "post.update", "post.delete"]);

function scan(
  files: Readonly<Record<string, string>>,
  known: ReadonlySet<string> = KNOWN,
): ScanResult {
  const cwd = project(files);
  return scanSources(
    cwd,
    Object.keys(files).map((file) => path.join(cwd, file)),
    known,
  );
}

describe("scanSources", () => {
  it("records definitions, roles, plans and permission roots", () => {
    const result = scan({
      "defs.ts": `import { definePermissions, defineRoles, definePlans } from 'permdock';
export const perms = definePermissions({});
export const roles = defineRoles({ clerk: {}, 'head-clerk': {}, [dynamic]: {}, ['lead']: {} });
export const plans = definePlans(base);
export default definePermissions({});
role('owner', []);
role(roles.clerk, []);
role(makeName(), []);
`,
      "alias.ts": `import { permissions as p } from './defs.ts';
import permissionsDefault from './other.ts';
import * as everything from './all.ts';
export const x = p.post.read;
`,
    });
    expect(result.roots).toEqual(["p", "permissions", "perms"]);
    expect(result.definitionFiles).toEqual({
      perms: "defs.ts",
      roles: "defs.ts",
      plans: "defs.ts",
    });
    expect(result.roleNames).toEqual(["clerk", "head-clerk", "lead", "owner"]);
    expect(result.planNames).toEqual([]);
    expect(result.usages["post.read"]).toEqual([
      { file: "alias.ts", line: 4, call: "reference" },
    ]);
  });

  it("names the call around a reference", () => {
    const result = scan({
      "calls.ts": `import { permissions } from './p.ts';
can(permissions.post.read);
permdock.decide(permissions.post.read);
allow(permissions.post.update);
export const tools = { edit: permissions.post.update };
other(permissions.post.delete);
(factory())(permissions.post.delete);
`,
    });
    expect(result.usages["post.read"]?.map((item) => item.call)).toEqual([
      "can",
      "decide",
    ]);
    expect(result.usages["post.update"]?.map((item) => item.call)).toEqual([
      "allow",
      "tools",
    ]);
    expect(result.usages["post.delete"]?.map((item) => item.call)).toEqual([
      "reference",
      "reference",
    ]);
    expect(result.allowKeys).toEqual(["post.update"]);
  });

  it("separates unknown keys, leaf fields, subtrees and dynamic access", () => {
    const result = scan({
      "refs.ts": `import { permissions } from './p.ts';
can(permissions.post.nope);
export const key = permissions.post.read.key;
export const tree = permissions.post;
export const root = permissions;
can(permissions.post[action]);
can(permissions['post'].read);
can(other[action]);
findPermission(permissions, 'post.update');
findPermission(permissions, 'post.gone');
findPermission(permissions, name);
`,
    });
    expect(result.unknown).toEqual([
      { file: "refs.ts", line: 2, call: "can:post.nope" },
      { file: "refs.ts", line: 10, call: "findPermission:post.gone" },
    ]);
    expect(result.usages["post.update"]).toEqual([
      { file: "refs.ts", line: 9, call: "findPermission" },
    ]);
    expect(result.usages["post.read"]).toBeUndefined();
    expect(result.dynamic).toEqual([
      { file: "refs.ts", line: 6, call: "can" },
      { file: "refs.ts", line: 11, call: "findPermission" },
    ]);
  });

  it("records every key when no catalog keys are known", () => {
    const result = scan(
      {
        "refs.ts": `import { permissions } from './p.ts';\ncan(permissions.anything.goes);\n`,
      },
      new Set(),
    );
    expect(Object.keys(result.usages)).toEqual(["anything.goes"]);
    expect(result.unknown).toEqual([]);
  });

  it("reads snapshot includes, and marks what it cannot read", () => {
    const result = scan({
      "snap.ts": `import { permissions } from './p.ts';
permdock.snapshot({ include: [permissions.post.read, permissions.post] });
snapshotFor(policy, subject, { include: [permissions.post.update] });
permdock.snapshot();
permdock.snapshot(options);
permdock.snapshot({ ...options });
permdock.snapshot({ subject });
permdock.snapshot({ include: list });
permdock.snapshot({ include: [other.post.read] });
permdock.snapshot({ include: [permissions] });
permdock.snapshot({ include: ['post.read'] });
`,
    });
    expect(result.snapshots.map((site) => [site.line, site.include])).toEqual([
      [2, ["post.read", "post"]],
      [3, ["post.update"]],
      [4, undefined],
      [5, null],
      [6, null],
      [7, undefined],
      [8, null],
      [9, null],
      [10, null],
      [11, null],
    ]);
  });

  it("skips a file the parser cannot read", () => {
    const result = scan({ "styles.css": "a { color: red }\n" });
    expect(result.usages).toEqual({});
  });
});

describe("scanSources: references follow bindings", () => {
  it("skips a local binding named permissions and keeps the imported tree", () => {
    const result = scan({
      "local.ts": `import { permissions } from './p.ts';
can(permissions.post.read);
export function grant(permissions: string[]) {
  return permissions.length + permissions.at(0);
}
export const list = (permissions) => permissions.map(String);
export const pick = ({ permissions }) => permissions.size;
export const spread = ([permissions = []]) => permissions.flat;
export function inner() {
  const permissions = ['a'];
  return permissions.join(',');
}
try {
  run();
} catch (permissions) {
  report(permissions.message);
}
for (const permissions of lists) {
  count(permissions.length);
}
for (let permissions = 0; permissions < 2; permissions += 1) {
  count(permissions.toFixed);
}
for (index = 0; index < 1; index += 1) {}
for (const permissions in table) {
  count(permissions.length);
}
export const named = function permissions() {
  return permissions.name;
};
class Box {
  static {
    const permissions = [];
    use(permissions.length);
  }
}
export { Box };
export class Holder2 {
  constructor(private permissions: string[]) {
    use(this.permissions.length);
  }
  size(...permissions) {
    return permissions.length;
  }
  keys({ ...permissions }) {
    return permissions.length;
  }
}
export default function (permissions) {
  return permissions.length;
}
switch (mode) {
  case 'a':
    const permissions = new Set();
    use(permissions.size);
}
{
  let permissions = {};
  use(permissions.keys);
}
can(permissions.post.update);
`,
    });
    expect(result.unknown).toEqual([]);
    expect(Object.keys(result.usages).toSorted()).toEqual([
      "post.read",
      "post.update",
    ]);
  });

  it("skips a module binding that is not a permission tree", () => {
    const result = scan({
      "array.ts": `export const permissions = ['a', 'b'];
export const size = permissions.length;
export function permissionsOf() {}
class Holder {}
enum Mode { A }
export default class Store {}
import * as everything from './all.ts';
import permissions2 from './other.ts';
`,
      "named.ts": `import { permissions } from './array.ts';
export function permissionsList(permissions) { return permissions.length; }
`,
    });
    expect(result.unknown).toEqual([]);
  });

  it("checks a tree defined inside a function or bound by another name", () => {
    const result = scan({
      "use.ts": `import { appPermissions as tree } from './defs.ts';
can(tree.post.read);
can(tree.post.archive);
`,
      "defs.ts": `import { definePermissions } from 'permdock';
export const appPermissions = definePermissions({});
export function fixture() {
  const permissions = definePermissions({});
  return permissions.post.nope;
}
`,
    });
    expect(result.usages["post.read"]).toEqual([
      { file: "use.ts", line: 2, call: "can" },
    ]);
    expect(result.unknown.map((item) => `${item.file}:${item.call}`)).toEqual([
      "use.ts:can:post.archive",
      "defs.ts:reference:post.nope",
    ]);
  });

  it("still reads an unbound permissions reference by name", () => {
    const result = scan({
      "generated.js": `can(permissions.post.read);
can(permissions.post.archive);
`,
    });
    expect(result.usages["post.read"]).toHaveLength(1);
    expect(result.unknown.map((item) => item.call)).toEqual([
      "can:post.archive",
    ]);
  });
});
