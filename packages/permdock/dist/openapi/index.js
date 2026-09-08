import { t as compact } from "../compact-CxCColYy.js";
import { o as listPermissions } from "../permissions-HC1OYNNj.js";
//#region src/openapi/pins.ts
const DRAFT_PINS = {
	oas: "3.3-dev@2026-09-01",
	securityProfiles: "oai-discussion-5304@2026-09-01",
	overlay: "1.2-dev@edd4adea"
};
const PROFILE_NAMES = { fapi2: "fapi-20-security-profile" };
const GNAP_RESERVED = "scheme.type 'gnap' is reserved and emits nothing. See https://permdock.dev/docs/standards/gnap";
//#endregion
//#region src/openapi/emit.ts
function assertScheme(options) {
	if (options.scheme.type === "gnap") throw new TypeError(GNAP_RESERVED);
}
function isLeaf(value) {
	return typeof value === "object" && value !== null && "key" in value && "kind" in value && "action" in value;
}
function asList(permission) {
	return isLeaf(permission) ? [permission] : permission;
}
function grantsOf(policy, permissions) {
	const keys = new Set(permissions.map((leaf) => leaf.key));
	return policy.roles.flatMap((role) => role.grants.filter((grant) => keys.has(grant.permission.key)));
}
function mergeRecord(base, extra) {
	const result = {};
	for (const [key, value] of Object.entries(base)) result[key] = value;
	for (const [key, value] of Object.entries(extra)) result[key] = value;
	return result;
}
function scopesOf(policy) {
	const scopes = {};
	for (const leaf of listPermissions(policy.permissions)) scopes[leaf.scope] = leaf.meta.description ?? leaf.meta.title ?? leaf.key;
	return scopes;
}
function flowWithScopes(flow, scopes) {
	return mergeRecord(flow ?? {}, { scopes });
}
function securitySchemesOf(policy, options) {
	assertScheme(options);
	const target = options.target ?? "3.2";
	const scopes = scopesOf(policy);
	const name = options.scheme.name;
	if (options.scheme.ref !== void 0 && target !== "3.1") return { [name]: { $ref: options.scheme.ref } };
	const flowsIn = options.scheme.flows ?? { authorizationCode: {} };
	const flows = {};
	if (flowsIn.authorizationCode !== void 0) flows.authorizationCode = flowWithScopes(flowsIn.authorizationCode, scopes);
	if (flowsIn.clientCredentials !== void 0) flows.clientCredentials = flowWithScopes(flowsIn.clientCredentials, scopes);
	if (flowsIn.deviceAuthorization !== void 0 && target !== "3.1") flows.deviceAuthorization = flowWithScopes(flowsIn.deviceAuthorization, scopes);
	const scheme = compact({
		type: options.scheme.type,
		flows: options.scheme.type === "oauth2" ? flows : void 0,
		openIdConnectUrl: options.scheme.type === "openIdConnect" ? options.scheme.openIdConnectUrl : void 0,
		oauth2MetadataUrl: target === "3.2" || target === "3.3" ? options.scheme.oauth2MetadataUrl : void 0,
		"x-permdock-oauth2MetadataUrl": target === "3.1" ? options.scheme.oauth2MetadataUrl : void 0,
		"x-oai-deviceAuthorization": target === "3.1" && flowsIn.deviceAuthorization !== void 0 ? flowWithScopes(flowsIn.deviceAuthorization, scopes) : void 0,
		"x-oai-deviceAuthorizationUrl": target === "3.1" && flowsIn.deviceAuthorization !== void 0 ? options.scheme.oauth2MetadataUrl : void 0,
		"x-permdock-securityProfile": options.securityProfile
	});
	const schemes = { [name]: scheme };
	if (target === "3.3" && options.securityProfile !== void 0) {
		const profileName = options.profileScheme ?? "permdockFapi2";
		schemes[profileName] = compact({
			type: "profile",
			profileMetadata: compact({
				name: PROFILE_NAMES[options.securityProfile],
				supportedParametersSchema: { $ref: "https://permdock.dev/schemas/fapi2-parameters.json" },
				servers: options.scheme.oauth2MetadataUrl === void 0 ? void 0 : [{ url: options.scheme.oauth2MetadataUrl }]
			}),
			"x-permdock-securityProfile": options.securityProfile
		});
	}
	return schemes;
}
function securityOf(options, permissions, anyOf) {
	assertScheme(options);
	const name = options.scheme.name;
	if (anyOf === true) return permissions.map((leaf) => ({ [name]: [leaf.scope] }));
	return [{ [name]: permissions.map((leaf) => leaf.scope) }];
}
function describeOf(policy, options, permissions, anyOf) {
	const grants = grantsOf(policy, permissions);
	const conditions = grants.map((grant) => grant.where).filter((where) => where !== void 0);
	const approval = grants.some((grant) => grant.approval === "human");
	return compact({
		security: securityOf(options, permissions, anyOf),
		"x-permdock-permissions": permissions.map((leaf) => leaf.key),
		"x-permdock-conditions": conditions.length > 0 ? conditions : void 0,
		"x-permdock-approval": approval ? "human" : void 0,
		"x-permdock-securityProfile": options.securityProfile,
		"x-badges": options.docsHints?.badges === true && approval ? [{ name: "Approval required" }] : void 0
	});
}
function catalogOf(options, extraDrafts) {
	const target = options.target ?? "3.2";
	const drafts = {};
	if (target === "3.3") {
		drafts.oas = DRAFT_PINS.oas;
		drafts.securityProfiles = DRAFT_PINS.securityProfiles;
	}
	if (extraDrafts !== void 0) for (const [key, value] of Object.entries(extraDrafts)) drafts[key] = value;
	return compact({
		v: 1,
		generator: "permdock/openapi",
		drafts: Object.keys(drafts).length > 0 ? drafts : void 0
	});
}
function securityProfileRequirementsOf(policy, options) {
	if ((options.target ?? "3.2") !== "3.3" || options.securityProfile === void 0) return;
	const profileName = options.profileScheme ?? "permdockFapi2";
	const scopes = Object.keys(scopesOf(policy)).toSorted();
	return { [scopes.join(",")]: { [profileName]: { scopes } } };
}
function openapiVersion(target) {
	switch (target) {
		case "3.1": return "3.1.0";
		case "3.2": return "3.2.0";
		case "3.3": return "3.3.0";
		default: return target;
	}
}
//#endregion
//#region src/openapi/overlay.ts
function pointerEscape(value) {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
function actionKey(keys) {
	return keys.toSorted().join(",");
}
function overlayOf(policy, options, overlayOptions = {}) {
	const version = overlayOptions.version ?? "1.1";
	const leaves = listPermissions(policy.permissions);
	const schemes = securitySchemesOf(policy, options);
	const requirements = securityProfileRequirementsOf(policy, options);
	const catalog = catalogOf(options, version === "1.2" ? { overlay: DRAFT_PINS.overlay } : void 0);
	const schemeAction = {
		target: "$.components.securitySchemes",
		description: "PermDock security schemes",
		update: schemes
	};
	const catalogAction = {
		target: "$",
		description: "PermDock catalog pin",
		update: { "x-permdock-catalog": catalog }
	};
	const requirementAction = requirements === void 0 ? void 0 : {
		target: "$.components.securityProfileRequirements",
		description: "PermDock security profile requirements",
		update: requirements
	};
	const operationBodies = leaves.map((leaf) => ({
		keys: [leaf.key],
		fields: describeOf(policy, options, [leaf]),
		target: `$.paths.*.*[?(@.operationId=='${leaf.key}')]`
	}));
	if (version === "1.1") {
		const actions = [schemeAction, catalogAction];
		if (requirementAction !== void 0) actions.push(requirementAction);
		for (const body of operationBodies) actions.push({
			target: body.target,
			description: `security for ${body.keys.join(",")}`,
			update: body.fields
		});
		return compact({
			overlay: "1.1.0",
			info: {
				title: "PermDock authorization overlay",
				version: "1"
			},
			extends: overlayOptions.extends,
			actions
		});
	}
	const reusable = {};
	const refs = [];
	for (const body of operationBodies) {
		const key = actionKey(body.keys);
		if (reusable[key] === void 0) reusable[key] = {
			description: `security for ${key}`,
			fields: { update: body.fields }
		};
		refs.push({
			$ref: `#/components/actions/${pointerEscape(key)}`,
			target: body.target,
			description: `security for ${key}`
		});
	}
	const actions = [schemeAction, catalogAction];
	if (requirementAction !== void 0) actions.push(requirementAction);
	return compact({
		overlay: "1.2.0",
		info: {
			title: "PermDock authorization overlay",
			version: "1"
		},
		extends: overlayOptions.extends,
		components: { actions: reusable },
		actions: [...actions, ...refs]
	});
}
//#endregion
//#region src/openapi/create.ts
function extendOperation(operation, extra) {
	const result = {};
	for (const [key, value] of Object.entries(operation)) result[key] = value;
	for (const [key, value] of Object.entries(extra)) result[key] = value;
	return result;
}
const createPermDock = (policy, options) => {
	return {
		securitySchemes() {
			return securitySchemesOf(policy, options);
		},
		security(permission, extra) {
			return securityOf(options, asList(permission), extra?.anyOf);
		},
		describe(permission, extra) {
			return describeOf(policy, options, asList(permission), extra?.anyOf);
		},
		spec(permission) {
			return (operation) => extendOperation(operation, describeOf(policy, options, asList(permission)));
		},
		overlay(overlayOptions) {
			return overlayOf(policy, options, overlayOptions ?? {});
		},
		securityProfileRequirements() {
			return securityProfileRequirementsOf(policy, options);
		},
		catalog() {
			return catalogOf(options);
		}
	};
};
//#endregion
export { DRAFT_PINS, GNAP_RESERVED, PROFILE_NAMES, catalogOf, createPermDock, openapiVersion, securitySchemesOf };
