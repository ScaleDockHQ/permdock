import { resolve } from "node:path";

import type { CommandResult } from "../core/result.ts";
import type { CliIo, PermDockConfig } from "../types.ts";

import {
  findPermission,
  hasConditionOp,
  getPermDock,
  memoryCustomRoleSource,
  type PermDock,
  type Permission,
  type Policy,
} from "../../index.ts";
import { usageResult } from "../core/errors.ts";
import { writeFileEnsuringDir } from "../files.ts";
import { fixtureRow, fixtureSubject, loadFixtures } from "../fixtures.ts";
import { pgConnector, type SqlConnect } from "../pg.ts";
import { loadPolicyAt } from "../project/load.ts";
import { commandFor } from "../sql/compile.ts";
import {
  expectedFields,
  fixtureKey,
  verifyAgainstDatabase,
  verifyTreeAgainstDatabase,
} from "./verify-database.ts";
import {
  type RlsFinding,
  type VerifyIgnore,
  rlsFinding,
  verifyResult,
} from "./verify-findings.ts";
import { type InProcess, emitPgtap } from "./verify-pgtap.ts";

/** Where `rls verify --kind pgtap` writes, the folder `supabase test db` reads. */
const PGTAP_OUT = "supabase/tests/permdock_rls.test.sql";

export function canFixture(
  permdock: PermDock,
  permission: Permission,
  row: unknown,
): boolean {
  if (permission.kind === "collection") {
    // SAFETY: kind was checked on the line above; Permission's kind parameter does not narrow.
    return permdock.can(
      permission as Permission<string, unknown, "collection">,
      row,
    );
  }
  // SAFETY: a permission is collection or instance, and collection returned above.
  return permdock.can(
    permission as Permission<string, unknown, "instance">,
    row,
  );
}

function grantKind(
  policy: Policy,
  key: string,
): "opaque" | "sqlFunction" | "portable" {
  const grants = policy.grants.filter((grant) => grant.permission.key === key);
  if (
    grants.some(
      (grant) =>
        hasConditionOp(grant.where, "opaque") ||
        hasConditionOp(grant.check, "opaque"),
    )
  ) {
    return "opaque";
  }
  if (
    grants.some(
      (grant) =>
        hasConditionOp(grant.where, "sqlFunction") ||
        hasConditionOp(grant.check, "sqlFunction"),
    )
  ) {
    return "sqlFunction";
  }
  return "portable";
}

export async function runRlsVerify(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly fixtures?: string;
  readonly db?: string;
  readonly from?: string;
  readonly format: "node" | "pgtap";
  /** `format: 'pgtap'`: the file to write, default {@link PGTAP_OUT}. */
  readonly out?: string;
  /** Check a generated tree with restricted branches instead of fixtures; needs `db`. */
  readonly tree?: boolean;
  readonly io: CliIo;
  /** Opens the `--db-url-stdin` connection; defaults to the `pg` peer. */
  readonly connect?: SqlConnect;
  /** Accepted findings: `rls.verify.ignore` and `--ignore`. */
  readonly ignore?: readonly VerifyIgnore[];
}): Promise<CommandResult> {
  const ignore = input.ignore ?? [];
  if (input.out !== undefined && input.format !== "pgtap") {
    return {
      code: 2,
      output: "PermDock CLI: rls verify --out needs --kind pgtap",
    };
  }
  const connect =
    input.connect ??
    pgConnector("permdock rls verify --db-url-stdin", input.cwd);
  const policyPath = input.from ?? input.config.policy;
  if (policyPath === undefined) {
    return {
      code: 2,
      output: "PermDock CLI: rls verify needs policy in the config or --policy",
    };
  }
  const policy: Policy = await loadPolicyAt(input.cwd, policyPath);
  if (input.tree === true) {
    if (input.db === undefined) {
      return {
        code: 2,
        output:
          "PermDock CLI: rls verify --tree needs a database: --db-url-stdin, DATABASE_URL or SUPABASE_DB_URL",
      };
    }
    try {
      return await verifyTreeAgainstDatabase(
        input.db,
        policy,
        input.config,
        connect,
        ignore,
      );
    } catch (cause) {
      return usageResult(cause);
    }
  }
  const fixturesPath =
    input.fixtures ?? input.config.rls?.fixtures ?? "rls.fixtures.json";
  const { fixtures, customRoles } = await loadFixtures(input.cwd, fixturesPath);
  const mismatches: RlsFinding[] = [];
  const notes: string[] = [];
  const inProcess: InProcess[] = [];
  const fieldsMode = input.config.rls?.fields !== undefined;
  for (const fixture of fixtures) {
    const permission = findPermission(policy.permissions, fixture.action);
    if (permission === undefined) {
      mismatches.push(
        rlsFinding(
          "unknown-permission",
          fixture.action,
          fixtureKey(fixture),
          `${fixture.action}: unknown permission`,
        ),
      );
      inProcess.push({
        action: fixture.action,
        granted: false,
        kind: "portable",
      });
      continue;
    }
    const kind = grantKind(policy, fixture.action);
    const permdock = await getPermDock(
      policy,
      fixtureSubject(fixture.subject),
      {
        customRoles: memoryCustomRoleSource(customRoles),
      },
    );
    const granted = canFixture(
      permdock,
      permission,
      fixtureRow(fixture, permission.kind),
    );
    const outcome = granted ? "granted" : "denied";
    if (fixture.expected !== undefined && fixture.expected !== outcome) {
      mismatches.push(
        rlsFinding(
          "expected-mismatch",
          fixture.action,
          fixtureKey(fixture),
          `${fixture.action}: in-process ${outcome}, expected ${fixture.expected}`,
        ),
      );
    }
    if (kind === "opaque") {
      notes.push(`${fixture.action}: opaque grant untestable app-side`);
    }
    const reads =
      fieldsMode &&
      permission.kind === "instance" &&
      commandFor(permission.action, input.config.rls?.actions) === "select";
    // SAFETY: reads is only true when permission.kind === 'instance'.
    const fields = reads
      ? expectedFields(
          granted,
          permdock.pick(
            permission as Permission<string, unknown, "instance">,
            fixture.row,
          ),
          policy.resources.get(permission.resource)?.id ?? "id",
          fixture.row,
        )
      : undefined;
    inProcess.push({
      action: fixture.action,
      granted,
      kind,
      ...(fields === undefined ? {} : { fields }),
    });
  }
  if (input.format === "pgtap") {
    const outRel = input.out ?? PGTAP_OUT;
    const result = verifyResult({
      findings: mismatches,
      ignore,
      summary: `wrote ${outRel}`,
    });
    if (result.code !== 0) {
      return result;
    }
    writeFileEnsuringDir(
      resolve(input.cwd, outRel),
      emitPgtap({
        fixtures,
        inProcess,
        policy,
        config: input.config,
        customRoles,
      }),
    );
    return result;
  }
  if (input.db !== undefined) {
    try {
      const database = await verifyAgainstDatabase({
        db: input.db,
        policy,
        fixtures,
        customRoles,
        config: input.config,
        inProcess,
        connect,
      });
      mismatches.push(...database.mismatches);
      notes.push(...database.notes);
    } catch (cause) {
      return usageResult(cause);
    }
  }
  return verifyResult({
    findings: mismatches,
    ignore,
    notes,
    summary: `verified ${String(fixtures.length)} fixture(s) ${input.db === undefined ? "in-process" : "in-process and against the database"}`,
  });
}
