import { describe, expect, it } from "vitest";

import { CliError } from "../../src/cli/core/errors.ts";
import { jiti, loadSync, oxc } from "../../src/cli/core/optional.ts";

describe("optional CLI peers", () => {
  it("loads the installed peers", () => {
    expect(oxc().parseSync("a.ts", "export const a = 1;").errors).toStrictEqual(
      [],
    );
    expect(jiti().createJiti).toBeTypeOf("function");
  });

  it("names the package and an install line when a peer is missing", () => {
    let caught: unknown;
    try {
      loadSync("permdock-peer-that-is-not-installed", "reading source files");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({
      code: "dependency_missing",
      message: expect.stringContaining(
        "reading source files needs the optional peer permdock-peer-that-is-not-installed",
      ),
    });
  });
});
