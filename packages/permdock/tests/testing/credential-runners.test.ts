import { describe } from "vitest";

import { memorySettings } from "../../src/core/interfaces.ts";
import {
  generateApiKey,
  memoryCredentials,
} from "../../src/server/credentials.ts";
import {
  testCredentialVerifier,
  testSettingsSource,
} from "../../src/testing/conformance.ts";

const NOW = Math.floor(Date.now() / 1000);

describe("testSettingsSource", () => {
  describe("a tenant with credential rules", () => {
    testSettingsSource(
      memorySettings({
        o_1: {
          credentials: {
            maxTtl: 86_400,
            kinds: ["user", "service"],
            approval: true,
          },
        },
      }),
      { tenant: "o_1", unknown: "o_9" },
    );
  });

  describe("a tenant with settings but no credential rules", () => {
    testSettingsSource(memorySettings({ o_1: {} }), { tenant: "o_1" });
  });

  describe("a tenant without settings", () => {
    testSettingsSource(memorySettings({}), { tenant: "o_1" });
  });

  describe("an async source", () => {
    const settings = memorySettings({ o_1: { credentials: {} } });
    testSettingsSource(
      {
        settingsFor: (tenant) => Promise.resolve(settings.settingsFor(tenant)),
      },
      { tenant: "o_1" },
    );
  });
});

describe("testCredentialVerifier without revoke", () => {
  const store = memoryCredentials();
  testCredentialVerifier(store, {
    key: () =>
      store.issue({
        v: 1,
        id: "key_1",
        kind: "user",
        principal: "u_1",
        permissions: [{ permission: "repo.read" }],
        createdBy: "u_1",
        createdAt: NOW,
        expiresAt: NOW + 3600,
      }),
  });
});

describe("testCredentialVerifier with a key given as a string", () => {
  const key = generateApiKey("A_1");
  testCredentialVerifier(
    {
      verify: (secret) =>
        secret === key
          ? {
              v: 1,
              id: "A_1",
              kind: "user",
              principal: "u_1",
              permissions: [{ permission: "repo.read" }],
              createdBy: "u_1",
              createdAt: NOW,
            }
          : null,
    },
    { key },
  );
});
