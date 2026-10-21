import { z } from "zod";

const read = (name: string): string | null => {
  const value = process.env[name] ?? "";
  return value.trim() === "" ? null : value;
};

const Cloud = z.object({
  url: z.url({ protocol: /^https?$/u }),
  key: z.string().min(1),
  environment: z.string().min(1).nullable(),
  webhookSecret: z.string().startsWith("whsec_").nullable(),
  approverJwk: z.string().min(1).nullable(),
  approverIssuer: z.string().min(1).nullable(),
});

export type CloudEnv = z.infer<typeof Cloud>;

/**
 * `null` unless `PERMDOCK_CLOUD_URL` and `PERMDOCK_CLOUD_KEY` are both set; one
 * without the other is a configuration error.
 */
function cloudEnv(): CloudEnv | null {
  const url = read("PERMDOCK_CLOUD_URL");
  const key = read("PERMDOCK_CLOUD_KEY");
  if (url === null && key === null) {
    return null;
  }
  return Cloud.parse({
    url,
    key,
    environment: read("PERMDOCK_CLOUD_ENV"),
    webhookSecret: read("PERMDOCK_CLOUD_WEBHOOK_SECRET"),
    approverJwk: read("PERMDOCK_CLOUD_APPROVER_JWK"),
    approverIssuer: read("PERMDOCK_CLOUD_APPROVER_ISSUER"),
  });
}

export const env = { cloud: cloudEnv() };
