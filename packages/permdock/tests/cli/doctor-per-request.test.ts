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

  it("follow a namespace import into an arrow function", () => {
    const text = `import * as pd from "permdock";

export const handler = () => pd.instanceCache();
`;
    expect(pd081([src(text)])).toHaveLength(1);
  });
});
