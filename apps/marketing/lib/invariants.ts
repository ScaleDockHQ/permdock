export type Invariant = {
  readonly title: string;
  readonly body: string;
};

export const invariants: readonly Invariant[] = [
  {
    title: 'Fail-closed',
    body: 'No grant, unknown role, invalid boundary data, unrecognised remote decision, or a thrown closure all deny. can() never throws.',
  },
  {
    title: 'Deny overrides allow',
    body: 'Allows OR together. Any matching deny wins.',
  },
  {
    title: 'Never emit service_role',
    body: 'Generated RLS never uses service_role. The database stays on the caller subject.',
  },
  {
    title: 'Never a model-supplied subject',
    body: 'Agents do not pick who they are. The subject comes from subjectFrom*, the request, or the session.',
  },
  {
    title: 'Never a default tenant',
    body: 'A requested tenant with no matching membership is no tenant. Team ids are identifiers, never display names.',
  },
];
