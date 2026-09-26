export type Job = {
  readonly id: string;
  readonly org: string;
  readonly projectId: string;
  /** The verified session user who enqueued it; never read from a body. */
  readonly onBehalfOf: string;
  status: 'queued' | 'running' | 'done' | 'denied';
  reason?: string;
};

let jobs: Job[] = [];
let next = 0;

export function enqueue(input: Omit<Job, 'id' | 'status'>): Job {
  next += 1;
  const job: Job = { ...input, id: `job-${String(next)}`, status: 'queued' };
  jobs.push(job);
  return job;
}

export function claim(): Job | undefined {
  const job = jobs.find((item) => item.status === 'queued');
  if (job !== undefined) {
    job.status = 'running';
  }
  return job;
}

export function findJob(id: string): Job | undefined {
  return jobs.find((job) => job.id === id);
}

export function settle(
  job: Job,
  status: 'done' | 'denied',
  reason?: string,
): void {
  job.status = status;
  if (reason !== undefined) {
    job.reason = reason;
  }
}

export function resetJobs(): void {
  jobs = [];
}
