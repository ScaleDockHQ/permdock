import type { DoctorFinding } from "./doctor-types.ts";
import type { CliIo, PermDockConfig } from "./types.ts";

import { scopeList } from "../core/scopes.ts";
import { supabaseTenantClaim } from "../supabase/budget.ts";
import { runCollect } from "./collect.ts";
import { pd064 } from "./doctor-assignments.ts";
import {
  pd002,
  pd003,
  pd004,
  pd016,
  pd017,
  pd018,
  pd019,
  pd020,
  pd021,
  pd023,
  pd024,
  pd025,
  pd026,
  pd027,
  pd029,
  pd030,
  pd031,
  pd032,
  pd033,
  pd034,
  pd035,
  pd037,
  pd055,
} from "./doctor-collect.ts";
import { pd042, pd043 } from "./doctor-declarative.ts";
import { pd044, pd065 } from "./doctor-next.ts";
import { pd058 } from "./doctor-powersync.ts";
import {
  pd005,
  pd006,
  pd009,
  pd012,
  pd022,
  pd028,
  pd040,
} from "./doctor-project.ts";
import { pd054 } from "./doctor-seeds.ts";
import {
  pd001,
  pd007,
  pd008,
  pd010,
  pd011,
  pd013,
  pd014,
  pd015,
  pd036,
  pd038,
  pd041,
  pd057,
} from "./doctor-source.ts";
import {
  pd046,
  pd047,
  pd048,
  pd049,
  pd050,
  pd051,
  pd052,
  pd053,
  pd056,
  pd062,
  pd063,
} from "./doctor-sql.ts";
import { pd061 } from "./doctor-suspension.ts";
import { listSourceFiles, rel } from "./files.ts";
import { type Project, loadProject } from "./project.ts";
import { runSkillsInstall } from "./skills.ts";
import { createStyle } from "./style.ts";
import { pd045 } from "./supabase-config.ts";
import { attrsPlan, hookOut, supabaseHookManifest } from "./supabase-hook.ts";
import { pd039 } from "./supabase-setup.ts";
import { DOCTOR_REPORT_SCHEMA } from "./version.ts";

export type { DoctorFinding, DoctorSeverity } from "./doctor-types.ts";

/** Static checks over the Supabase migrations; `--only sql` runs them alone. */
const SQL_CHECKS = [
  ["PD046", pd046],
  ["PD047", pd047],
  ["PD048", pd048],
  ["PD049", pd049],
  ["PD050", pd050],
  ["PD051", pd051],
  ["PD052", pd052],
  ["PD053", pd053],
  ["PD062", pd062],
  ["PD063", pd063],
] as const;

export type DoctorReport = {
  readonly $schema: typeof DOCTOR_REPORT_SCHEMA;
  readonly findings: readonly DoctorFinding[];
  readonly errors: number;
  readonly warnings: number;
};

/**
 * One doctor check: its code, the `--only` groups that select it, and an
 * optional precondition on the config. `runDoctor` runs the table in order.
 */
export type DoctorCheck = {
  readonly code: `PD${string}`;
  readonly groups: readonly string[];
  readonly when?: (config: PermDockConfig) => boolean;
  readonly run: (
    project: Project,
  ) => readonly DoctorFinding[] | Promise<readonly DoctorFinding[]>;
};

export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  {
    code: "PD001",
    groups: ["imports"],
    run: (project) =>
      pd001(
        project.sources(),
        new Set(
          listSourceFiles(
            project.cwd,
            project.config.doctor?.clientEntries ?? [],
          ).map((file) => rel(project.cwd, file)),
        ),
        project.config.policy === undefined
          ? undefined
          : { cwd: project.cwd, path: project.config.policy },
      ),
  },
  { code: "PD059", groups: ["project"], run: pd059 },
  { code: "PD060", groups: ["project"], run: pd060 },
  { code: "PD002", groups: ["references"], run: pd002 },
  { code: "PD003", groups: ["ungranted"], run: pd003 },
  { code: "PD004", groups: ["catalog"], run: pd004 },
  { code: "PD005", groups: ["skills"], run: (project) => pd005(project.cwd) },
  {
    code: "PD006",
    groups: ["typescript"],
    run: (project) => pd006(project.cwd),
  },
  {
    code: "PD007",
    groups: ["validation"],
    run: (project) => pd007(project.sources()),
  },
  {
    code: "PD008",
    groups: ["naming"],
    run: (project) => pd008(project.sources()),
  },
  {
    code: "PD009",
    groups: ["duplicates"],
    run: (project) => pd009(project.cwd),
  },
  {
    code: "PD010",
    groups: ["claims"],
    run: (project) => pd010(project.sources()),
  },
  {
    code: "PD011",
    groups: ["tenant"],
    run: (project) => pd011(project.sources()),
  },
  {
    code: "PD012",
    groups: ["drafts"],
    run: (project) => pd012(project.cwd, project.config),
  },
  {
    code: "PD013",
    groups: ["algorithms"],
    run: (project) => pd013(project.sources()),
  },
  {
    code: "PD014",
    groups: ["discovery"],
    run: (project) => pd014(project.sources()),
  },
  {
    code: "PD015",
    groups: ["typ"],
    run: (project) => pd015(project.sources()),
  },
  { code: "PD016", groups: ["rls"], run: pd016 },
  { code: "PD017", groups: ["sensitive"], run: pd017 },
  { code: "PD018", groups: ["separation"], run: pd018 },
  { code: "PD019", groups: ["jwt-roles"], run: pd019 },
  { code: "PD020", groups: ["hosted"], run: pd020 },
  {
    code: "PD021",
    groups: ["hosted"],
    run: (project) => pd021({ ...project, env: project.io.env ?? process.env }),
  },
  {
    code: "PD022",
    groups: ["views"],
    run: (project) => pd022(project.cwd, project.config),
  },
  { code: "PD023", groups: ["custom-roles"], run: pd023 },
  { code: "PD024", groups: ["self-approval"], run: pd024 },
  { code: "PD025", groups: ["scopes"], run: pd025 },
  { code: "PD026", groups: ["ownership"], run: pd026 },
  { code: "PD027", groups: ["rls", "context-refs"], run: pd027 },
  {
    code: "PD028",
    groups: ["attrs", "supabase"],
    run: (project) => pd028(project.cwd, project.config, attrsPlan),
  },
  { code: "PD029", groups: ["credentials"], run: pd029 },
  { code: "PD030", groups: ["fields"], run: pd030 },
  { code: "PD031", groups: ["graph"], run: pd031 },
  { code: "PD032", groups: ["graph", "rls"], run: pd032 },
  { code: "PD033", groups: ["activation"], run: pd033 },
  { code: "PD034", groups: ["break-glass"], run: pd034 },
  { code: "PD035", groups: ["support"], run: pd035 },
  {
    code: "PD036",
    groups: ["bola"],
    run: (project) => pd036(project.sources()),
  },
  { code: "PD037", groups: ["supabase", "row-conditions"], run: pd037 },
  {
    code: "PD039",
    groups: ["supabase", "helpers"],
    when: (config) => config.supabase?.hook !== undefined,
    run: supabaseSetup,
  },
  {
    code: "PD038",
    groups: ["supabase", "tenant"],
    when: (config) =>
      config.rls !== undefined || config.supabase?.hook !== undefined,
    run: (project) =>
      pd038(
        project.sources(),
        project.config.rls?.tenantClaim ?? supabaseTenantClaim,
        supabaseTenantClaim,
      ),
  },
  {
    code: "PD057",
    groups: ["supabase", "anonymous"],
    when: (config) => config.rls?.anonymousSignIns === "deny",
    run: (project) => pd057(project.sources()),
  },
  {
    code: "PD040",
    groups: ["supabase", "auth-role"],
    run: (project) => pd040(project.cwd, project.config),
  },
  {
    code: "PD041",
    groups: ["supabase", "capabilities"],
    run: (project) => pd041(project.sources()),
  },
  {
    code: "PD042",
    groups: ["supabase", "declarative"],
    run: (project) => pd042(project.cwd, project.config),
  },
  {
    code: "PD043",
    groups: ["supabase", "declarative"],
    run: (project) => pd043(project.cwd),
  },
  { code: "PD045", groups: ["supabase"], run: (project) => pd045(project.cwd) },
  ...SQL_CHECKS.map(([code, check]): DoctorCheck => ({
    code,
    groups: ["supabase", "sql"],
    run: (project) => check(project.cwd, project.config),
  })),
  { code: "PD054", groups: ["supabase", "seeds"], run: pd054 },
  { code: "PD055", groups: ["custom-roles", "renamed"], run: pd055 },
  {
    code: "PD056",
    groups: ["sql", "shims"],
    run: (project) => pd056(project.cwd, project.config),
  },
  { code: "PD058", groups: ["powersync"], run: pd058 },
  {
    code: "PD061",
    groups: ["rls", "suspension"],
    when: (config) => config.rls?.suspension?.scopes !== undefined,
    run: pd061,
  },
  {
    code: "PD064",
    groups: ["rls", "assignments"],
    when: (config) => config.rls?.assignments !== undefined,
    run: pd064,
  },
  { code: "PD044", groups: ["next", "endpoint"], run: pd044 },
  { code: "PD065", groups: ["react-native", "endpoint"], run: pd065 },
];

export async function runDoctor(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly only: readonly string[];
  readonly json: boolean;
  readonly fix: boolean;
  readonly strict: boolean;
  readonly color: boolean;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  if (input.fix) {
    runSkillsInstall({
      cwd: input.cwd,
      agents: [],
    });
    await runCollect({
      cwd: input.cwd,
      config: input.config,
      collect: input.config.collect ?? {},
      check: false,
      now: input.now,
      io: input.io,
    });
  }
  const project = loadProject(input);
  const wanted = new Set(input.only.map((item) => item.toLowerCase()));
  const selected = (check: DoctorCheck): boolean =>
    wanted.size === 0 ||
    wanted.has(check.code.toLowerCase()) ||
    check.groups.some((group) => wanted.has(group));

  const findings: DoctorFinding[] = [];
  for (const check of DOCTOR_CHECKS) {
    if (check.when !== undefined && !check.when(input.config)) {
      continue;
    }
    if (selected(check)) {
      findings.push(...(await check.run(project)));
    }
  }

  const errors = findings.filter((item) => item.severity === "error").length;
  const warnings = findings.filter(
    (item) => item.severity === "warning",
  ).length;
  const report: DoctorReport = {
    $schema: DOCTOR_REPORT_SCHEMA,
    findings,
    errors,
    warnings,
  };
  const code: 0 | 1 = errors > 0 || (input.strict && warnings > 0) ? 1 : 0;
  return {
    code,
    output: input.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatDoctor(report, input.color),
  };
}

/** PD059: the configured policy module throws or exports no policy, so every policy check is skipped. */
async function pd059(project: Project): Promise<readonly DoctorFinding[]> {
  const load = await project.policyLoad();
  if (load.status !== "failed") {
    return [];
  }
  return [
    {
      code: "PD059",
      severity: "error",
      message: `policy module ${load.path} did not load (${load.message}), so doctor skipped every check that reads the policy`,
      fix: "fix the module so it exports policy from definePolicy, or point policy in permdock.config.ts at the module that does",
    },
  ];
}

/** PD060: a source file under srcPath has a syntax error, so collect and usage miss what it references. */
async function pd060(project: Project): Promise<readonly DoctorFinding[]> {
  const collected = await project.collected();
  return (collected.scan?.unparsed ?? []).map((item) => ({
    code: "PD060",
    severity: "warning" as const,
    message: `${item.file}:${String(item.line)} does not parse (${item.message}), so the catalog and usage report miss the permissions it references`,
    fix: "fix the syntax error, or exclude the file from collect.srcPath",
  }));
}

function formatDoctor(report: DoctorReport, color: boolean): string {
  const style = createStyle(color);
  const lines = [style.paint("bold", "permdock doctor"), ""];
  for (const finding of report.findings) {
    const mark =
      finding.severity === "error" ? style.errorMark : style.warnMark;
    lines.push(
      `  ${mark} ${style.paint("bold", finding.code)}  ${finding.message}`,
    );
    lines.push(`           ${style.paint("dim", `fix: ${finding.fix}`)}`);
  }
  if (report.findings.length === 0) {
    lines.push("  no findings");
  }
  lines.push("");
  lines.push(
    `  ${String(report.errors)} error${report.errors === 1 ? "" : "s"}, ${String(report.warnings)} warning${report.warnings === 1 ? "" : "s"}`,
  );
  return `${lines.join("\n")}\n`;
}

async function supabaseSetup(
  input: Project,
): Promise<readonly DoctorFinding[]> {
  const policy = await input.policy();
  if (policy === undefined) {
    return [];
  }
  let manifest;
  try {
    manifest = supabaseHookManifest(
      scopeList(policy.scopes),
      input.config,
      { out: hookOut(input.cwd, input.config) },
      policy,
    );
  } catch {
    return [];
  }
  return pd039({ cwd: input.cwd, config: input.config, manifest });
}
