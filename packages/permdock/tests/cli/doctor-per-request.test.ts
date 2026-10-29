import { describe, expect, it } from "vitest";

import type { DoctorSource } from "../../src/cli/shared/doctor-types.ts";

import { pd080, pd081 } from "../../src/cli/doctor/per-request.ts";

function src(text: string): DoctorSource {
  return { file: "src/lib/access.ts", text };
}

describe("PD080 and PD081 per-request sources and caches", () => {
  it("warn for each factory created inside a function body", () => {
    const text = `import { instanceCache, memoryVersionCache } from "permdock";
import { postgrestSources } from "permdock/supabase";

export async function permdockFor(request: Request) {
  const sources = postgrestSources(admin);
  const versions = memoryVersionCache();
  const instances = instanceCache();
  return getPermDock(app, await currentSubject(request), { instances });
}
`;
    expect(pd080([src(text)]).map((finding) => finding.message)).toStrictEqual([
      "src/lib/access.ts:5 creates postgrestSources() inside a function, so every call starts with no shared version reads",
      "src/lib/access.ts:6 creates memoryVersionCache() inside a function, so every call starts with no shared version reads",
    ]);
    expect(pd081([src(text)])).toMatchObject([
      { code: "PD081", severity: "warning" },
    ]);
  });

  it("warn for a claimsFirst created per call, which defeats the instance cache", () => {
    const text = `import { claimsFirst } from "permdock";

const memberships = claimsFirst(source, { onStale: "reread", versions });

export const options = () => ({
  memberships: claimsFirst(source, { onStale: "reread", versions }),
  instances,
});
`;
    expect(pd080([src(text)])).toStrictEqual([
      {
        code: "PD080",
        severity: "warning",
        target: "src/lib/access.ts:6",
        message:
          "src/lib/access.ts:6 creates claimsFirst() inside a function, so every call passes a new memberships source, which the instance cache compares by identity, and no instance is reused",
        fix: "create claimsFirst(...) once at module scope, or use permdockFor(...).sources(versions), and pass the same object to every adapter",
      },
    ]);
    expect(pd081([src(text)])).toStrictEqual([]);
  });

  it("pass module scope, a lazy ??= singleton and functions PermDock does not export", () => {
    const text = `import * as pd from "permdock";
import { postgrestSources } from "permdock/supabase";
import { instanceCache as localCache } from "./cache";

const sources = postgrestSources(admin);
const instances = pd.instanceCache();
let versions: VersionCache | undefined;

export function shared() {
  versions ??= pd.memoryVersionCache();
  return localCache();
}
`;
    expect(pd080([src(text)])).toStrictEqual([]);
    expect(pd081([src(text)])).toStrictEqual([]);
  });

  it("skip type imports and other calls, and follow a quoted import name", () => {
    const text = `import { type instanceCache as cacheType, "instanceCache" as quoted } from "permdock";
import * as pd from "permdock";

export function handler(other: Other) {
  let count = 0;
  count += 1;
  cacheType();
  other.instanceCache();
  pd.helper();
  pd["instanceCache"]();
  return quoted();
}
`;
    expect(pd081([src(text)])).toMatchObject([{ code: "PD081" }]);
    expect(
      pd081([src("export function f() { return instanceCache(); }")]),
    ).toStrictEqual([]);
  });

  it("follow a namespace import into an arrow function", () => {
    const text = `import * as pd from "permdock";

export const handler = () => pd.instanceCache();
`;
    expect(pd081([src(text)])).toHaveLength(1);
  });
});

describe("PD080 exemptions", () => {
  const head = `import { claimsFirst } from "permdock";\n`;

  it("accepts ||=, an if (!x) guard and a cache helper named in doctor.cacheHelpers", () => {
    const text = `${head}
let a;
let b;
export function one() {
  a ||= claimsFirst(source, {});
  if (!b) b = claimsFirst(source, {});
  if (!b) {
    b = claimsFirst(source, {});
  }
  return once(() => claimsFirst(source, {}));
}
`;
    expect(pd080([src(text)])).toHaveLength(1);
    expect(pd080([src(text)], ["once"])).toStrictEqual([]);
  });

  it("still warns on an if (!x) guard that assigns another name", () => {
    const text = `${head}
let a;
let b;
export function one() {
  if (!a) b = claimsFirst(source, {});
}
`;
    expect(pd080([src(text)])).toHaveLength(1);
  });
});
