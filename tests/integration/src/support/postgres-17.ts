import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Postgres17 = {
  /** A superuser connection string to the `postgres` database. */
  readonly url: string;
  readonly stop: () => Promise<void>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("PermDock test: no port for Postgres"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/** A fresh cluster from the `initdb` and `pg_ctl` in `bin`. */
async function startNative(bin: string): Promise<Postgres17> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-pg-"));
  const data = join(dir, "data");
  const port = await freePort();
  execFileSync(join(bin, "initdb"), [
    "-D",
    data,
    "-U",
    "postgres",
    "--auth=trust",
    "-E",
    "UTF8",
  ]);
  execFileSync(join(bin, "pg_ctl"), [
    "-D",
    data,
    "-o",
    `-p ${String(port)} -k ${dir} -c listen_addresses=127.0.0.1`,
    "-l",
    join(dir, "log"),
    "-w",
    "start",
  ]);
  return {
    url: `postgresql://postgres@127.0.0.1:${String(port)}/postgres`,
    stop: () => {
      execFileSync(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "stop"]);
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

/**
 * One throwaway Postgres 17 cluster per suite, with no Supabase roles or
 * schemas: the suite installs its own stub. `PERMDOCK_POSTGRES_BIN` names a
 * directory with `initdb` and `pg_ctl` to run without Docker; the cluster is
 * new either way, because roles are cluster-wide.
 */
export async function startPostgres17(): Promise<Postgres17> {
  const bin = process.env["PERMDOCK_POSTGRES_BIN"];
  if (bin !== undefined && bin !== "") {
    return startNative(bin);
  }
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
