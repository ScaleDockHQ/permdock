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
