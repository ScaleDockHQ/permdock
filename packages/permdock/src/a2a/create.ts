import type { Decision } from "../core/decision.ts";
import type { ProblemDetails } from "../core/errors.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy } from "../core/policy.ts";
import type { Actor, Delegation, Principal } from "../core/subject.ts";
import type {
  A2aAgentCard,
  A2aAuth,
  A2aPermDock,
  A2aPermDockOptions,
  A2aSecurityScheme,
  A2aSkill,
  A2aSkillConfig,
  A2aTaskOutcome,
  A2aWireSecurityScheme,
} from "./types.ts";

import { resumeDecision, storedApprovalToken } from "../approvals/helpers.ts";
import { canonicalJson } from "../core/canonical-json.ts";
import { compact } from "../core/compact.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
} from "../core/errors.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { mayUse } from "../core/may-use.ts";
import { challengeScope, scopesReaching } from "../core/oauth-scopes.ts";
import { createPermDock as createCorePermDock } from "../core/permdock.ts";
import { bytesToBase64Url } from "../core/sha256.ts";
import { bearerChallenge } from "../server/problem.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstScheme(options: A2aPermDockOptions): string | undefined {
  return Object.keys(options.securitySchemes)[0];
}

function skillOf(
  id: string,
  config: A2aSkillConfig,
  scheme: string | undefined,
): A2aSkill {
  return {
    id,
    name: id,
    description: config.description ?? config.permission.key,
    tags: config.tags ?? [config.permission.resource],
    securityRequirements:
      scheme === undefined
        ? []
        : [{ schemes: { [scheme]: { list: [config.permission.scope] } } }],
  };
}

function publicSkills(options: A2aPermDockOptions): readonly A2aSkill[] {
  const scheme = firstScheme(options);
  return Object.entries(options.skills).map(([id, config]) =>
    skillOf(id, config, scheme),
  );
}

function wireScheme(scheme: A2aSecurityScheme): A2aWireSecurityScheme {
  switch (scheme.type) {
    case "oauth2":
      return {
        oauth2SecurityScheme: compact({
          oauth2MetadataUrl: scheme.oauth2MetadataUrl,
          description: scheme.description,
        }),
      };
    case "http":
      return {
        httpAuthSecurityScheme: compact({
          scheme: scheme.scheme,
          bearerFormat: scheme.bearerFormat,
          description: scheme.description,
        }),
      };
    case "openIdConnect":
      return {
        openIdConnectSecurityScheme: compact({
          openIdConnectUrl: scheme.openIdConnectUrl,
          description: scheme.description,
        }),
      };
    case "mutualTLS":
      return {
        mtlsSecurityScheme: compact({ description: scheme.description }),
      };
    case "apiKey":
      return {
        apiKeySecurityScheme: compact({
          location: scheme.in,
          name: scheme.name,
          description: scheme.description,
        }),
      };
    default: {
      const exhaustive: never = scheme;
      return exhaustive;
    }
  }
}

function cardOf(
  options: A2aPermDockOptions,
  skills: readonly A2aSkill[],
): A2aAgentCard {
  const info = options.card;
  return compact<A2aAgentCard>({
    name: info.name,
    description: info.description ?? info.name,
    version: info.version,
    supportedInterfaces: [
      {
        url: info.url,
        protocolBinding: info.protocolBinding ?? "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    provider: info.provider,
    documentationUrl: info.documentationUrl,
    iconUrl: info.iconUrl,
    capabilities: compact({
      extendedAgentCard: true as const,
      streaming: info.streaming,
      pushNotifications: info.pushNotifications,
    }),
    defaultInputModes: info.defaultInputModes ?? DEFAULT_MODES,
    defaultOutputModes: info.defaultOutputModes ?? DEFAULT_MODES,
    securitySchemes: Object.fromEntries(
      Object.entries(options.securitySchemes).map(([name, scheme]) => [
        name,
        wireScheme(scheme),
      ]),
    ),
    skills,
  });
}

const DEFAULT_MODES: readonly string[] = ["text/plain"];

function delegationOf(auth: A2aAuth): Delegation | undefined {
  return compact<Delegation>({
    scopes: auth.scopes,
    authorizationDetails: auth.extra?.authorizationDetails,
  });
}

function actorOf(auth: A2aAuth): Actor | undefined {
  return typeof auth.clientId === "string" && auth.clientId !== ""
    ? { id: auth.clientId, kind: "oauth-client" }
    : undefined;
}

async function resolveTenant(
  tenant: A2aPermDockOptions["tenant"],
  auth: A2aAuth,
): Promise<string | undefined> {
  if (tenant === undefined || typeof tenant === "string") {
    return tenant;
  }
  try {
    return await tenant(auth);
  } catch {
    return undefined;
  }
}

function hasScope(auth: A2aAuth, scopes: readonly string[]): boolean {
  return scopes.some((scope) => auth.scopes?.includes(scope) === true);
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  if (!isRecord(data)) {
    return { type: permission.resource };
  }
  const id = data["id"];
  return typeof id === "string" || typeof id === "number"
    ? { type: permission.resource, id: String(id) }
    : { type: permission.resource };
}

const LOAD_FAILED: Extract<Decision, { readonly outcome: "denied" }> = {
  outcome: "denied",
  denials: [{ role: null, reason: "validation" }],
  alternatives: [],
};

function deniedOutcome(
  decision: Extract<Decision, { readonly outcome: "denied" }>,
  permission: Permission,
  data: unknown,
  permdock: PermDock,
): A2aTaskOutcome {
  const error = new PermDockDeniedError({
    decision,
    permission: permission.key,
    scope: permission.scope,
    resource: resourceRef(permission, data),
    subject: permdock.subject,
    message: `${permission.key} denied.`,
  });
  return {
    ok: false,
    status: 403,
    state: "failed",
    problem: error.toProblemDetails(),
  };
}

function approvalOutcome(
  decision: Extract<Decision, { readonly outcome: "approval-required" }>,
  permission: Permission,
  data: unknown,
): A2aTaskOutcome {
  const error = new PermDockApprovalRequiredError({
    decision,
    permission: permission.key,
    scope: permission.scope,
    resource: resourceRef(permission, data),
    message: `${permission.key} requires human approval.`,
  });
  return {
    ok: false,
    status: 403,
    state: "input-required",
    problem: error.toProblemDetails(),
  };
}

/** A2A 1.0 section 8.4: a detached JWS over the RFC 8785 form of the card. */
async function signCard(
  card: A2aAgentCard,
  signPayload: (payload: string) => Promise<string>,
): Promise<A2aAgentCard> {
  const { signatures = [], ...unsigned } = card;
  const payload = canonicalJson(unsigned);
  const jws = await signPayload(payload);
  const [header, body, signature, extra] = jws.split(".");
  if (
    header === undefined ||
    signature === undefined ||
    extra !== undefined ||
    body !== bytesToBase64Url(new TextEncoder().encode(payload))
  ) {
    throw new TypeError(
      "PermDock: an A2A card signer must return a compact JWS over the payload it was given",
    );
  }
  return {
    ...card,
    signatures: [...signatures, { protected: header, signature }],
  };
}

function missingScope(permission: Permission, scope: string): A2aTaskOutcome {
  const problem: ProblemDetails = {
    type: "https://permdock.com/problems/unauthenticated",
    title: "Insufficient scope",
    status: 401,
    detail: `insufficient_scope: ${scope}`,
    permission: permission.key,
    scope,
  };
  return {
    ok: false,
    status: 401,
    state: "failed",
    problem,
    wwwAuthenticate: bearerChallenge({
      error: "insufficient_scope",
      scopes: [scope],
    }),
  };
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: A2aPermDockOptions<TUser>,
): A2aPermDock {
  for (const [id, config] of Object.entries(options.skills)) {
    if (config.permission.kind === "instance" && config.data === undefined) {
      throw new TypeError(
        `PermDock: A2A skill '${id}' checks ${config.permission.key} on a row and needs a data loader; the task body is never used as the row`,
      );
    }
  }
  const instanceFor = async (auth: A2aAuth): Promise<PermDock> => {
    let user: TUser | null = null;
    try {
      user = await options.subject(auth);
    } catch {
      user = null;
    }
    const tenant = await resolveTenant(options.tenant, auth);
    return createCorePermDock(
      policy,
      user,
      compact({
        tenant,
        actor: actorOf(auth),
        delegation: delegationOf(auth),
        ...instanceOptions(options),
      }),
    );
  };

  const agentCard = (): A2aAgentCard => cardOf(options, publicSkills(options));

  const extendedAgentCard = async (auth: A2aAuth): Promise<A2aAgentCard> => {
    const permdock = await instanceFor(auth);
    const scheme = firstScheme(options);
    const skills: A2aSkill[] = [];
    for (const [id, config] of Object.entries(options.skills)) {
      if (mayUse(permdock, config.permission)) {
        skills.push(skillOf(id, config, scheme));
      }
    }
    return cardOf(options, skills);
  };

  const protectSkill =
    (selector: (task: unknown) => string) =>
    async (task: unknown, auth: A2aAuth): Promise<A2aTaskOutcome> => {
      const id = selector(task);
      const config = Object.hasOwn(options.skills, id)
        ? options.skills[id]
        : undefined;
      if (config === undefined) {
        return {
          ok: false,
          status: 403,
          state: "failed",
          problem: {
            type: "https://permdock.com/problems/denied",
            title: "Permission denied",
            status: 403,
            detail: "unknown skill",
          },
        };
      }
      if (!hasScope(auth, scopesReaching(policy, config.permission))) {
        return missingScope(
          config.permission,
          challengeScope(policy, config.permission),
        );
      }
      const permdock = await instanceFor(auth);
      let data: unknown;
      if (config.data !== undefined) {
        try {
          data = await config.data(task);
        } catch {
          return deniedOutcome(
            LOAD_FAILED,
            config.permission,
            undefined,
            permdock,
          );
        }
        if (
          config.permission.kind === "instance" &&
          (data === null || data === undefined)
        ) {
          return deniedOutcome(
            LOAD_FAILED,
            config.permission,
            undefined,
            permdock,
          );
        }
      }
      let decision: Decision;
      try {
        // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
        const raw = (
          permdock.decide as (
            next: Permission,
            row?: unknown,
            decideOptions?: DecideOptions,
          ) => Decision
        )(
          config.permission,
          data,
          compact<DecideOptions>({
            source: "adapter",
            adapter: "a2a",
            trusted: false,
            boundary: "tool-args",
          }),
        );
        decision = await resumeDecision({
          decision: raw,
          permission: config.permission,
          subject: permdock.subject,
          store: options.store,
          resource: resourceRef(config.permission, data),
          adapter: "a2a",
          token:
            auth.extra?.approval ??
            (await storedApprovalToken(options.store, raw)),
        });
      } catch {
        return deniedOutcome(LOAD_FAILED, config.permission, data, permdock);
      }
      switch (decision.outcome) {
        case "granted":
          return { ok: true };
        case "denied":
          return deniedOutcome(decision, config.permission, data, permdock);
        case "approval-required":
          return approvalOutcome(decision, config.permission, data);
        default: {
          const exhaustive: never = decision;
          return exhaustive;
        }
      }
    };

  return { agentCard, extendedAgentCard, protectSkill, sign: signCard };
}
