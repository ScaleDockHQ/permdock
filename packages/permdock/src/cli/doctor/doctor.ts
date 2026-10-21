import type { CommandResult } from "../core/result.ts";
import type { Style } from "../core/style.ts";
import type { Project } from "../project/project.ts";
import type { DoctorFinding, DoctorSeverity } from "../shared/doctor-types.ts";
import type { CliIo, PermDockConfig } from "../types.ts";

import { scopeList } from "../../core/scopes.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { runCollect } from "../collect.ts";
import { didYouMean } from "../core/args.ts";
import { DOCS_BASE } from "../core/manifest.ts";
import { findingOf } from "../core/output.ts";
import { createStyle } from "../core/style.ts";
import { DOCTOR_REPORT_SCHEMA } from "../core/version.ts";
import { listSourceFiles, rel } from "../files.ts";
import { loadProject } from "../project/project.ts";
import { runSkillsInstall } from "../skills.ts";
import { pd045, pd074 } from "../supabase-config.ts";
import { attrsPlan } from "../supabase-hook/claims.ts";
import {
  hookOut,
  supabaseHookManifest,
} from "../supabase-hook/supabase-hook.ts";
import { pd039 } from "../supabase-setup.ts";
import { pd064 } from "./assignments.ts";
import { pd002, pd003, pd004, pd067, pd070 } from "./catalog.ts";
import { pd077 } from "./config-names.ts";
import { pd042, pd043, pd068, pd069 } from "./declarative.ts";
import { pd018, pd023, pd025, pd029, pd055 } from "./fixtures.ts";
import { pd044, pd065 } from "./next.ts";
import { pd017, pd019, pd021, pd024, pd026, pd033, pd035 } from "./policy.ts";
import { pd058 } from "./powersync.ts";
import { pd005, pd006, pd009, pd012, pd022, pd028, pd040 } from "./project.ts";
import {
  pd016,
  pd020,
  pd027,
  pd030,
  pd031,
  pd032,
  pd034,
  pd037,
  pd071,
  pd072,
  pd073,
  pd075,
  pd076,
} from "./rls.ts";
import { pd054 } from "./seeds.ts";
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
} from "./source.ts";
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
  pd066,
  pd062,
  pd063,
} from "./sql.ts";
import { pd061 } from "./suspension.ts";

export type { DoctorFinding, DoctorSeverity } from "../shared/doctor-types.ts";

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
  /** What `--fix` changed before the checks ran; empty without `--fix`. */
  readonly fixed: readonly string[];
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
  {
    code: "PD067",
    groups: ["catalog", "operations"],
    when: (config) => config.operations !== undefined,
    run: pd067,
  },
  {
    code: "PD070",
    groups: ["catalog", "better-supabase"],
    when: (config) => config.policy !== undefined,
    run: pd070,
  },
  {
    code: "PD005",
    groups: ["skills"],
    run: (project) => pd005(project.cwd, project.files),
  },
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
    run: (project) => pd009(project.cwd, project.files),
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
    run: (project) => pd012(project.cwd, project.config, project.files),
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
    run: (project) => pd022(project.cwd, project.config, project.files),
  },
  { code: "PD023", groups: ["custom-roles"], run: pd023 },
  { code: "PD024", groups: ["self-approval"], run: pd024 },
  { code: "PD025", groups: ["scopes"], run: pd025 },
  { code: "PD026", groups: ["ownership"], run: pd026 },
  { code: "PD027", groups: ["rls", "context-refs"], run: pd027 },
  { code: "PD071", groups: ["rls"], run: pd071 },
  { code: "PD072", groups: ["rls"], run: pd072 },
  { code: "PD073", groups: ["rls", "ownership"], run: pd073 },
  { code: "PD075", groups: ["rls"], run: pd075 },
  { code: "PD076", groups: ["rls"], run: pd076 },
  { code: "PD077", groups: ["rls", "scopes"], run: pd077 },
  {
    code: "PD028",
    groups: ["attrs", "supabase"],
    run: (project) =>
      pd028(project.cwd, project.config, attrsPlan, project.files),
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
    run: (project) => pd040(project.cwd, project.config, project.files),
  },
  {
    code: "PD041",
    groups: ["supabase", "capabilities"],
    run: (project) => pd041(project.sources()),
  },
  {
    code: "PD042",
    groups: ["supabase", "declarative"],
    run: (project) => pd042(project.cwd, project.config, project.files),
  },
  {
    code: "PD043",
    groups: ["supabase", "declarative"],
    run: (project) => pd043(project.cwd, project.config, project.files),
  },
  {
    code: "PD068",
    groups: ["supabase", "declarative"],
    run: (project) => pd068(project.cwd, project.config, project.files),
  },
  {
    code: "PD069",
    groups: ["supabase", "declarative"],
    run: (project) => pd069(project.cwd, project.config, project.files),
  },
  { code: "PD045", groups: ["supabase"], run: (project) => pd045(project.cwd) },
  {
    code: "PD074",
    groups: ["supabase", "helpers"],
    when: (config) => config.supabase?.hook !== undefined,
    run: (project) => pd074(project.cwd, project.config),
  },
  ...SQL_CHECKS.map(([code, check]): DoctorCheck => ({
    code,
    groups: ["supabase", "sql"],
    run: (project) => check(project.cwd, project.config, project.files),
  })),
  { code: "PD054", groups: ["supabase", "seeds"], run: pd054 },
  { code: "PD055", groups: ["custom-roles", "renamed"], run: pd055 },
  {
    code: "PD056",
    groups: ["sql", "shims"],
    run: (project) => pd056(project.cwd, project.config, project.files),
  },
  {
    code: "PD066",
    groups: ["sql", "shims"],
    when: (config) => config.rls?.migrate?.tables !== undefined,
    run: (project) => pd066(project.cwd, project.config, project.files),
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
}): Promise<CommandResult> {
  const wanted = new Set(input.only.map((item) => item.toLowerCase()));
  const unknown = unknownOnly(wanted);
  if (unknown !== undefined) {
    return { code: 2, output: unknown };
  }
  const fixed: string[] = [];
  if (input.fix) {
    const skills = runSkillsInstall({ cwd: input.cwd, agents: [] });
    fixed.push(`skills: ${skills.output}`);
    const collected = await runCollect({
      cwd: input.cwd,
      config: input.config,
      collect: input.config.collect ?? {},
      check: false,
      now: input.now,
      io: input.io,
    });
    fixed.push(`catalog: ${collected.message.trim()}`);
  }
  const project = loadProject(input);
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
    fixed,
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
    findings: findings.map((item) =>
      findingOf({ ...item, docs: `${DOCS_BASE}/doctor#checks` }),
    ),
  };
}

/**
 * PD059: the configured policy module throws or exports no policy, so every
 * policy check is skipped.
 */
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

/**
 * PD060: a source file under srcPath has a syntax error, so collect and usage
 * miss what it references.
 */
async function pd060(project: Project): Promise<readonly DoctorFinding[]> {
  const collected = await project.collected();
  return (collected.scan?.unparsed ?? []).map((item) => ({
    code: "PD060",
    severity: "warning" as const,
    message: `${item.file}:${String(item.line)} does not parse (${item.message}), so the catalog and usage report miss the permissions it references`,
    fix: "fix the syntax error, or exclude the file from collect.srcPath",
  }));
}

/**
 * A usage message for the first `--only` value that names no check code or
 * group.
 */
function unknownOnly(wanted: ReadonlySet<string>): string | undefined {
  const known = new Set<string>();
  for (const check of DOCTOR_CHECKS) {
    known.add(check.code.toLowerCase());
    for (const group of check.groups) {
      known.add(group);
    }
  }
  for (const item of wanted) {
    if (!known.has(item)) {
      const suggestion = didYouMean(item, [...known]);
      return `doctor: --only ${item} names no check code or group${suggestion === undefined ? "" : `. Did you mean ${suggestion}?`}`;
    }
  }
  return undefined;
}

function formatDoctor(report: DoctorReport, color: boolean): string {
  const style = createStyle(color);
  const lines = [style.paint("bold", "permdock doctor"), ""];
  for (const change of report.fixed) {
    lines.push(`  ${style.okMark} fixed ${change}`);
  }
  if (report.fixed.length > 0) {
    lines.push("");
  }
  for (const finding of report.findings) {
    const mark = markOf(finding.severity, style);
    lines.push(
      `  ${mark} ${style.paint("bold", finding.code)}  ${finding.message}`,
    );
    lines.push(`           ${style.paint("dim", `fix: ${finding.fix}`)}`);
  }
  if (report.findings.length === 0) {
    lines.push("  no findings");
  }
  lines.push("");
  const notes = report.findings.filter(
    (finding) => finding.severity === "info",
  ).length;
  lines.push(
    `  ${String(report.errors)} error${report.errors === 1 ? "" : "s"}, ${String(report.warnings)} warning${report.warnings === 1 ? "" : "s"}${notes === 0 ? "" : `, ${String(notes)} note${notes === 1 ? "" : "s"}`}`,
  );
  return `${lines.join("\n")}\n`;
}

function markOf(severity: DoctorSeverity, style: Style): string {
  switch (severity) {
    case "error":
      return style.errorMark;
    case "warning":
      return style.warnMark;
    case "info":
      return style.infoMark;
    default: {
      const unknown: never = severity;
      return unknown;
    }
  }
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
