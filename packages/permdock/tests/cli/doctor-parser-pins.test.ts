import { afterEach, describe, expect, it } from "vitest";

import {
  pd126,
  permdockParserVersions,
} from "../../src/cli/doctor/parser-pins.ts";
import { project, removeProjects } from "./doctor-kit.ts";

describe("PD126 parser pins", () => {
  afterEach(removeProjects);

  const own = { "oxc-parser": "0.159.0", "pgsql-parser": "18.4.2" };

  it("reports a listed parser that installs another version than permdock pins", () => {
    const cwd = project({
      "package.json": JSON.stringify({
        devDependencies: { "pgsql-parser": "^17.0.0", "oxc-parser": "0.159.0" },
      }),
      "node_modules/pgsql-parser/package.json": JSON.stringify({
        name: "pgsql-parser",
        version: "17.9.1",
      }),
      "node_modules/oxc-parser/package.json": JSON.stringify({
        name: "oxc-parser",
        version: "0.159.0",
      }),
    });
    expect(pd126(cwd, undefined, own)).toStrictEqual([
      {
        code: "PD126",
        severity: "info",
        target: "pgsql-parser",
        message:
          "package.json lists pgsql-parser ^17.0.0, which installs 17.9.1; permdock pins 18.4.2, so the project holds two copies",
        fix: "remove pgsql-parser from package.json: permdock depends on it at the version its findings are tested with",
      },
    ]);
  });

  it("skips a parser at the pinned version and one the app does not list", () => {
    const cwd = project({
      "package.json": JSON.stringify({
        dependencies: { "oxc-parser": "0.159.0" },
      }),
      "node_modules/oxc-parser/package.json": JSON.stringify({
        name: "oxc-parser",
        version: "0.159.0",
      }),
    });
    expect(pd126(cwd, undefined, own)).toStrictEqual([]);
    expect(
      pd126(project({ "package.json": "{}" }), undefined, own),
    ).toStrictEqual([]);
  });

  it("resolves the versions permdock itself installs", () => {
    expect(Object.keys(permdockParserVersions()).toSorted()).toStrictEqual([
      "oxc-parser",
      "pgsql-parser",
    ]);
  });
});
