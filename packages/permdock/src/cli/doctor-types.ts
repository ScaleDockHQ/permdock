export type DoctorSeverity = "error" | "warning";

export type DoctorFinding = {
  readonly code: string;
  readonly severity: DoctorSeverity;
  readonly message: string;
  readonly fix: string;
};

export type DoctorSource = {
  readonly file: string;
  readonly text: string;
};
