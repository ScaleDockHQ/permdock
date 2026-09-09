import { t as freezeDeep } from "../freeze-BF4IK5al.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { t as anonymousSubject } from "../subject-DgYVJ_Q0.js";
//#region src/supabase/rls.ts
function isTable(value) {
	return value !== null && typeof value === "object" && "table" in value && typeof value.table === "string";
}
function supabaseRls(options = {}) {
	const raw = options.memberships;
	const memberships = raw === void 0 ? void 0 : isTable(raw) ? { tenant: raw } : raw;
	return compact({
		dialect: "supabase",
		roleClaim: options.roleClaim ?? "user_role",
		tenantClaim: options.tenantClaim ?? "tenant_id",
		memberships
	});
}
function authorizeSql(options = {}) {
	const tenant = options.tenant === true;
	return `create or replace function public.authorize(
  requested_permission public.app_permission${tenant ? ",\n  requested_tenant uuid default null" : ""}
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  binduid uuid;
  user_role public.app_role;
begin
  select (select auth.uid()) into binduid;
  select ur.role into user_role from public.user_roles ur where ur.user_id = binduid;
  if user_role is null then
    return false;
  end if;${tenant ? "\n  perform requested_tenant;" : ""}
  return exists (
    select 1
    from public.role_permissions rp
    where rp.role = user_role
      and rp.permission = requested_permission
  );
end;
$$;
`;
}
//#endregion
//#region src/supabase/subject.ts
const REGISTERED = /* @__PURE__ */ new Set([
	"sub",
	"role",
	"iss",
	"aud",
	"exp",
	"iat",
	"nbf",
	"aal",
	"amr",
	"acr",
	"session_id",
	"email",
	"phone",
	"is_anonymous",
	"app_metadata",
	"user_metadata"
]);
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readClaim(claims, name) {
	if (Object.hasOwn(claims, name) && claims[name] !== void 0) return claims[name];
	const meta = claims.app_metadata;
	if (isRecord(meta) && Object.hasOwn(meta, name)) return meta[name];
}
function asRoles(value, declared) {
	const raw = typeof value === "string" ? value === "" ? [] : [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
	if (declared === void 0) return raw;
	const allowed = new Set(declared);
	return raw.filter((role) => allowed.has(role));
}
function asMemberships(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (!isRecord(item) || !Array.isArray(item.roles)) continue;
		const roles = item.roles.filter((role) => typeof role === "string");
		if (roles.length === 0) continue;
		const tenant = typeof item.tenant === "string" ? item.tenant : void 0;
		const team = typeof item.team === "string" ? item.team : void 0;
		const onRecord = isRecord(item.on) ? item.on : void 0;
		const on = onRecord !== void 0 && typeof onRecord.resource === "string" && typeof onRecord.id === "string" ? {
			resource: onRecord.resource,
			id: onRecord.id
		} : void 0;
		if (tenant === void 0 && team === void 0 && on === void 0) continue;
		out.push(compact({
			roles,
			tenant,
			team,
			on
		}));
	}
	return out;
}
function validateClaims(extra, schema) {
	const result = schema["~standard"].validate(extra);
	if (result instanceof Promise) return;
	if ("issues" in result && result.issues !== void 0) return;
	const value = result.value;
	return isRecord(value) ? value : void 0;
}
function extraClaims(claims) {
	const extra = {};
	const meta = claims.app_metadata;
	if (isRecord(meta)) for (const [key, value] of Object.entries(meta)) extra[key] = value;
	for (const [key, value] of Object.entries(claims)) {
		if (REGISTERED.has(key) || key === "user_metadata") continue;
		extra[key] = value;
	}
	return extra;
}
function mapClaims(claims, options) {
	const role = claims.role;
	if (role === "anon" || role === "service_role") return anonymousSubject();
	const id = claims.sub;
	if (typeof id !== "string" || id === "") return anonymousSubject();
	const roleClaim = options.roles ?? "user_role";
	const tenantClaim = options.tenant ?? "tenant_id";
	const membershipsClaim = options.memberships ?? "memberships";
	let extra = extraClaims(claims);
	if (options.schema !== void 0) extra = validateClaims(extra, options.schema) ?? {};
	const include = new Set(options.include ?? []);
	const tenantValue = readClaim(claims, tenantClaim);
	const principal = compact({
		id,
		kind: "user",
		roles: asRoles(readClaim(claims, roleClaim), options.declared),
		tenant: typeof tenantValue === "string" ? tenantValue : void 0,
		memberships: asMemberships(readClaim(claims, membershipsClaim)),
		issuer: typeof claims.iss === "string" ? claims.iss : void 0,
		assurance: typeof claims.aal === "string" ? { acr: claims.aal } : void 0,
		claims: Object.keys(extra).length === 0 ? void 0 : extra,
		email: include.has("email") && typeof claims.email === "string" ? claims.email : void 0,
		phone: include.has("phone") && typeof claims.phone === "string" ? claims.phone : void 0,
		is_anonymous: include.has("is_anonymous") && typeof claims.is_anonymous === "boolean" ? claims.is_anonymous : void 0
	});
	const session = typeof claims.session_id === "string" ? claims.session_id : void 0;
	const expiresAt = typeof claims.exp === "number" ? claims.exp : void 0;
	return freezeDeep(compact({
		principal,
		context: {},
		session,
		expiresAt
	}));
}
function subjectFromSupabase(claims, options = {}) {
	try {
		if (!isRecord(claims)) return anonymousSubject();
		const rest = {};
		for (const [key, value] of Object.entries(claims)) {
			if (key === "user_metadata") continue;
			rest[key] = value;
		}
		return mapClaims(rest, options);
	} catch {
		return anonymousSubject();
	}
}
//#endregion
export { authorizeSql, subjectFromSupabase, supabaseRls };
