import { z } from "zod";

const Url = z.url({ protocol: /^https?$/u });

const Cloud = z.object({
  url: Url,
  environment: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export type CloudEnv = z.infer<typeof Cloud>;

const Project = z.object({
  url: Url,
  project: z.string().min(1),
  token: z.string().min(1),
});

export type ProjectEnv = z.infer<typeof Project>;

const read = (name: string): string | null => {
  const value = process.env[name] ?? "";
  return value.trim() === "" ? null : value;
};

/**
 * `null` unless every Cloud variable is set; a partial set is a configuration
 * error.
 */
function cloudEnv(): CloudEnv | null {
  const raw = {
    url: read("PERMDOCK_CLOUD_URL"),
    environment: read("PERMDOCK_CLOUD_ENV") ?? "production",
    clientId: read("PERMDOCK_CLOUD_CLIENT_ID"),
    clientSecret: read("PERMDOCK_CLOUD_CLIENT_SECRET"),
  };
  if (raw.url === null && raw.clientId === null && raw.clientSecret === null) {
    return null;
  }
  return Cloud.parse(raw);
}

/**
 * `null` unless the project and its read-only token are set; the URL defaults
 * to production.
 */
function projectEnv(): ProjectEnv | null {
  const raw = {
    url: read("PERMDOCK_CLOUD_URL") ?? "https://permdock.com/api",
    project: read("PERMDOCK_CLOUD_PROJECT"),
    token: read("PERMDOCK_CLOUD_TOKEN"),
  };
  if (raw.project === null && raw.token === null) {
    return null;
  }
  return Project.parse(raw);
}

export const env = {
  cloud: cloudEnv(),
  /** The Cloud project whose pushed policy `serve-cloud.ts` serves. */
  project: projectEnv(),
  /** The `client` key; with it the parity test also runs `testCloudApi`. */
  cloudKey: read("PERMDOCK_CLOUD_KEY"),
  /**
   * A private JWK whose issuer the environment trusts, for the approver checks
   * of `testCloudApi`.
   */
  approverJwk: read("PERMDOCK_CLOUD_APPROVER_JWK"),
  approverIssuer: read("PERMDOCK_CLOUD_APPROVER_ISSUER"),
};
