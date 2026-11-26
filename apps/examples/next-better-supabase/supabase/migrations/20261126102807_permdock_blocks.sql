SET local check_function_bodies = off;

DROP POLICY "quotes_select" ON "public"."quotes";

DROP POLICY "quotes_update" ON "public"."quotes";

DROP POLICY "permdock_authz_version_receive" ON "realtime"."messages";

DROP POLICY "permdock_realtime_org_organization_quotes_insert" ON "realtime"."messages";

DROP POLICY "permdock_realtime_org_organization_quotes_select" ON "realtime"."messages";

DROP POLICY "realtime_messages_insert_read_only_actors" ON "realtime"."messages";

DROP POLICY "permdock_storage_quote_files_delete" ON "storage"."objects";

DROP POLICY "permdock_storage_quote_files_insert" ON "storage"."objects";

DROP POLICY "permdock_storage_quote_files_select" ON "storage"."objects";

DROP POLICY "permdock_storage_quote_files_update" ON "storage"."objects";

DROP POLICY "storage_objects_delete_read_only_actors" ON "storage"."objects";

DROP POLICY "storage_objects_insert_read_only_actors" ON "storage"."objects";

DROP POLICY "storage_objects_update_read_only_actors" ON "storage"."objects";

DROP VIEW "permdock"."permdock_ceiling";

DROP VIEW "permdock"."permission_keys";

DROP FUNCTION "permdock"."permdock_custom_role_beyond_for"(uuid, uuid, text, text, text[], text[], text[]);

DROP FUNCTION "permdock"."permdock_custom_role_guard_for"(uuid, uuid, text, text, text);

DROP TABLE "permdock"."approval_requests";

CREATE TABLE "better_supabase"."access_requests" (
  "id"            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"     uuid                     NOT NULL,
  "user_id"       uuid                     NOT NULL,
  "role"          text                     NOT NULL,
  "previous_role" text,
  "reason"        text,
  "duration"      interval,
  "approval_id"   uuid,
  "granted_at"    timestamp with time zone,
  "expires_at"    timestamp with time zone,
  "ended_at"      timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "access_requests_pkey" PRIMARY KEY (id),
  CONSTRAINT "bsb_access_requests_duration_check" CHECK (((duration IS NULL) OR (duration > '00:00:00'::interval))),
  CONSTRAINT "bsb_access_requests_reason_check" CHECK (((reason IS NULL) OR (length(reason) <= 2000))),
  CONSTRAINT "bsb_access_requests_role_check" CHECK (((length(role) >= 1) AND (length(role) <= 200)))
);

ALTER TABLE "better_supabase"."access_requests"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."api_keys" (
  "id"                uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"         uuid,
  "user_id"           uuid,
  "name"              text                     NOT NULL,
  "prefix"            text                     NOT NULL,
  "public_id"         text                     NOT NULL,
  "secret_hash"       text                     NOT NULL,
  "scopes"            text[]                   NOT NULL DEFAULT '{}'::text[],
  "rate_limit"        integer,
  "window_started_at" timestamp with time zone,
  "window_hits"       integer                  NOT NULL DEFAULT 0,
  "expires_at"        timestamp with time zone,
  "last_used_at"      timestamp with time zone,
  "revoked_at"        timestamp with time zone,
  "rotated_from"      uuid,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "kind"              text,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY (id),
  CONSTRAINT "api_keys_public_id_key" UNIQUE (public_id),
  CONSTRAINT "bsb_api_keys_check" CHECK (((tenant_id IS NOT NULL) OR (user_id IS NOT NULL))),
  CONSTRAINT "bsb_api_keys_name_check" CHECK ((length(TRIM(BOTH FROM name)) > 0)),
  CONSTRAINT "bsb_api_keys_prefix_check" CHECK ((prefix ~ '^[a-z][a-z0-9]*$'::text)),
  CONSTRAINT "bsb_api_keys_public_id_check" CHECK ((public_id ~ '^[0-9a-f]{16}$'::text)),
  CONSTRAINT "bsb_api_keys_rate_limit_check" CHECK ((rate_limit > 0)),
  CONSTRAINT "bsb_api_keys_secret_hash_check" CHECK ((secret_hash ~ '^[0-9a-f]{64}$'::text)),
  "created_by"        uuid                     DEFAULT auth.uid()
);

ALTER TABLE "better_supabase"."api_keys"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "better_supabase"."api_keys"
  SET (fillfactor=80);

CREATE TABLE "better_supabase"."approval_decisions" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "request_id"  uuid                     NOT NULL,
  "tenant_id"   uuid                     NOT NULL,
  "step"        integer                  NOT NULL,
  "approver"    uuid,
  "decision"    text                     NOT NULL,
  "delegate_to" uuid,
  "comment"     text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "approval_decisions_pkey" PRIMARY KEY (id),
  CONSTRAINT "approval_decisions_request_id_step_approver_key" UNIQUE (request_id, step, approver),
  CONSTRAINT "bsb_approval_decisions_check" CHECK (((decision = 'delegated'::text) = (delegate_to IS NOT NULL))),
  CONSTRAINT "bsb_approval_decisions_comment_check" CHECK (((comment IS NULL) OR (length(comment) <= 2000))),
  CONSTRAINT "bsb_approval_decisions_decision_check" CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text, 'delegated'::text])))
);

ALTER TABLE "better_supabase"."approval_decisions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."approval_items" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "request_id"   uuid                     NOT NULL,
  "tenant_id"    uuid                     NOT NULL,
  "key"          text                     NOT NULL,
  "label"        text,
  "payload"      jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "permission"   text,
  "depends_on"   text[]                   NOT NULL DEFAULT '{}'::text[],
  "status"       text                     NOT NULL DEFAULT 'pending'::text,
  "created_type" text,
  "created_id"   text,
  "decided_by"   uuid,
  "decided_at"   timestamp with time zone,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "approval_items_pkey" PRIMARY KEY (id),
  CONSTRAINT "approval_items_request_id_key_key" UNIQUE (request_id, key),
  CONSTRAINT "bsb_approval_items_check" CHECK (((created_type IS NULL) = (created_id IS NULL))),
  CONSTRAINT "bsb_approval_items_key_check" CHECK (((length(key) >= 1) AND (length(key) <= 200))),
  CONSTRAINT "bsb_approval_items_label_check" CHECK (((label IS NULL) OR (length(label) <= 500))),
  CONSTRAINT "bsb_approval_items_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

ALTER TABLE "better_supabase"."approval_items"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."approval_requests" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    uuid                     NOT NULL,
  "subject_type" text                     NOT NULL,
  "subject_id"   text                     NOT NULL,
  "action"       text                     NOT NULL,
  "policy"       jsonb                    NOT NULL,
  "step"         integer                  NOT NULL DEFAULT 0,
  "status"       text                     NOT NULL DEFAULT 'pending'::text,
  "requested_by" uuid,
  "reason"       text,
  "payload"      jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "expires_at"   timestamp with time zone,
  "reminded_at"  timestamp with time zone,
  "decided_at"   timestamp with time zone,
  "fingerprint"  text,
  "consumed_at"  timestamp with time zone,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "token"        text,
  "body"         jsonb,
  CONSTRAINT "approval_requests_pkey" PRIMARY KEY (id),
  CONSTRAINT "bsb_approval_requests_consumed_check" CHECK (((status = 'consumed'::text) = (consumed_at IS NOT NULL))),
  CONSTRAINT "bsb_approval_requests_fingerprint_check" CHECK (((fingerprint IS NULL) OR (fingerprint ~ '^[0-9a-f]{64}$'::text))),
  CONSTRAINT "bsb_approval_requests_reason_check" CHECK (((reason IS NULL) OR (length(reason) <= 2000))),
  CONSTRAINT "bsb_approval_requests_status_check"
    CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text, 'consumed'::text]))),
  CONSTRAINT "bsb_approval_requests_step_check" CHECK ((step >= 0))
);

ALTER TABLE "better_supabase"."approval_requests"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."automation_defaults" (
  "key"          text                     NOT NULL,
  "block"        text                     NOT NULL,
  "subject_type" text                     NOT NULL,
  "trigger"      text                     NOT NULL,
  "name"         text                     NOT NULL,
  "description"  text,
  "conditions"   jsonb                    NOT NULL DEFAULT '{"id": "root", "type": "group", "rules": [], "combinator": "and"}'::jsonb,
  "actions"      jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "enabled"      boolean                  NOT NULL DEFAULT true,
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "automation_defaults_pkey" PRIMARY KEY (key),
  CONSTRAINT "bsb_automation_defaults_actions_check" CHECK ((jsonb_typeof(actions) = 'array'::text)),
  CONSTRAINT "bsb_automation_defaults_description_check" CHECK ((length(description) <= 2000)),
  CONSTRAINT "bsb_automation_defaults_key_check" CHECK (((length(key) <= 128) AND (key ~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$'::text))),
  CONSTRAINT "bsb_automation_defaults_name_check" CHECK (((length(name) >= 1) AND (length(name) <= 200))),
  CONSTRAINT "bsb_automation_defaults_subject_type_check" CHECK ((subject_type ~ '^[a-z][a-z0-9_-]{0,62}$'::text)),
  CONSTRAINT "bsb_automation_defaults_trigger_check" CHECK (((length(trigger) <= 128) AND (trigger ~ '^[a-z][a-z0-9_]*([.:][a-z0-9_]+)*$'::text)))
);

ALTER TABLE "better_supabase"."automation_defaults"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."automation_evaluations" (
  "id"           bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "tenant_id"    uuid                     NOT NULL,
  "rule_id"      uuid                     NOT NULL,
  "version"      integer                  NOT NULL,
  "subject_type" text                     NOT NULL,
  "subject_id"   text,
  "trigger"      text                     NOT NULL,
  "matched"      boolean                  NOT NULL,
  "results"      jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "mode"         text                     NOT NULL DEFAULT 'live'::text,
  "evaluated_by" uuid,
  "evaluated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "automation_evaluations_pkey" PRIMARY KEY (id),
  CONSTRAINT "bsb_automation_evaluations_mode_check" CHECK ((mode = ANY (ARRAY['live'::text, 'test'::text])))
);

ALTER TABLE "better_supabase"."automation_evaluations"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."automation_fields" (
  "subject_type" text                     NOT NULL,
  "field_id"     text                     NOT NULL,
  "label"        text                     NOT NULL,
  "description"  text,
  "type"         text                     NOT NULL,
  "path"         text                     NOT NULL,
  "column_type"  text                     NOT NULL,
  "nullable"     boolean                  NOT NULL DEFAULT true,
  "options"      jsonb,
  "operators"    jsonb,
  "position"     integer                  NOT NULL DEFAULT 0,
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "automation_fields_pkey" PRIMARY KEY (subject_type, field_id),
  CONSTRAINT "bsb_automation_fields_check" CHECK (((type <> 'date'::text) OR (column_type = ANY (ARRAY['date'::text, 'timestamp'::text, 'timestamptz'::text])))),
  CONSTRAINT "bsb_automation_fields_field_id_check" CHECK (((length(field_id) <= 128) AND (field_id ~ '^[A-Za-z_][A-Za-z0-9_]*([.][A-Za-z_][A-Za-z0-9_]*)*$'::text))),
  CONSTRAINT "bsb_automation_fields_path_check" CHECK ((path ~ '^[A-Za-z_][A-Za-z0-9_]*([.][A-Za-z_][A-Za-z0-9_]*)*$'::text)),
  CONSTRAINT "bsb_automation_fields_subject_type_check" CHECK ((subject_type ~ '^[a-z][a-z0-9_-]{0,62}$'::text)),
  CONSTRAINT "bsb_automation_fields_type_check"
    CHECK ((type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'select'::text, 'relation'::text, 'multiselect'::text, 'boolean'::text])))
);

ALTER TABLE "better_supabase"."automation_fields"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."automation_versions" (
  "rule_id"    uuid                     NOT NULL,
  "version"    integer                  NOT NULL,
  "tenant_id"  uuid                     NOT NULL,
  "name"       text                     NOT NULL,
  "conditions" jsonb                    NOT NULL,
  "actions"    jsonb                    NOT NULL,
  "saved_by"   uuid,
  "saved_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "automation_versions_pkey" PRIMARY KEY (rule_id, VERSION)
);

ALTER TABLE "better_supabase"."automation_versions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."automations" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"       uuid                     NOT NULL,
  "subject_type"    text                     NOT NULL,
  "trigger"         text                     NOT NULL,
  "name"            text                     NOT NULL,
  "description"     text,
  "conditions"      jsonb                    NOT NULL,
  "actions"         jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "enabled"         boolean                  NOT NULL DEFAULT false,
  "stop_processing" boolean                  NOT NULL DEFAULT false,
  "rank"            text                     COLLATE pg_catalog."C" NOT NULL DEFAULT 'V'::text,
  "version"         integer                  NOT NULL DEFAULT 1,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "default_key"     text,
  CONSTRAINT "automations_pkey" PRIMARY KEY (id),
  CONSTRAINT "bsb_automations_actions_check" CHECK ((jsonb_typeof(actions) = 'array'::text)),
  CONSTRAINT "bsb_automations_description_check" CHECK ((length(description) <= 2000)),
  CONSTRAINT "bsb_automations_name_check" CHECK (((length(name) >= 1) AND (length(name) <= 200))),
  CONSTRAINT "bsb_automations_subject_type_check" CHECK ((subject_type ~ '^[a-z][a-z0-9_-]{0,62}$'::text)),
  CONSTRAINT "bsb_automations_trigger_check" CHECK (((length(trigger) <= 128) AND (trigger ~ '^[a-z][a-z0-9_]*([.:][a-z0-9_]+)*$'::text))),
  "created_by"      uuid                     DEFAULT auth.uid(),
  "updated_by"      uuid                     DEFAULT auth.uid()
);

ALTER TABLE "better_supabase"."automations"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."invitations" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   uuid                     NOT NULL,
  "email"       text                     NOT NULL,
  "role"        text                     NOT NULL,
  "token_hash"  text                     NOT NULL,
  "expires_at"  timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "invited_by"  uuid,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "accepted_by" uuid,
  "declined_at" timestamp with time zone,
  "revoked_at"  timestamp with time zone,
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invitations_pkey" PRIMARY KEY (id),
  CONSTRAINT "invitations_token_hash_key" UNIQUE (token_hash)
);

ALTER TABLE "better_supabase"."invitations"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."maintenance_state" (
  "job"         text                     NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_status" text,
  "last_result" jsonb,
  "last_error"  text,
  "runs"        bigint                   NOT NULL DEFAULT 0,
  CONSTRAINT "bsb_maintenance_state_last_status_check" CHECK ((last_status = ANY (ARRAY['ok'::text, 'error'::text]))),
  CONSTRAINT "maintenance_state_pkey" PRIMARY KEY (job)
);

ALTER TABLE "better_supabase"."maintenance_state"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."organization_payment_accounts" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"  uuid                     NOT NULL,
  "iban"       text                     NOT NULL,
  "bic"        text,
  "holder"     text,
  "label"      text,
  "is_primary" boolean                  NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organization_payment_accounts_pkey" PRIMARY KEY (id),
  CONSTRAINT "organization_payment_accounts_tenant_id_iban_key" UNIQUE (tenant_id, iban)
);

ALTER TABLE "better_supabase"."organization_payment_accounts"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."organization_profiles" (
  "tenant_id"       uuid                     NOT NULL,
  "vat_id"          text,
  "registration_id" text,
  "default_rate"    numeric,
  "currency"        text,
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organization_profiles_pkey" PRIMARY KEY (tenant_id)
);

ALTER TABLE "better_supabase"."organization_profiles"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."organization_settings" (
  "tenant_id"  uuid                     NOT NULL,
  "key"        text                     NOT NULL,
  "value"      jsonb                    NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_organization_settings_key_check" CHECK ((key ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'::text)),
  CONSTRAINT "organization_settings_pkey" PRIMARY KEY (tenant_id, key),
  "updated_by" uuid                     DEFAULT auth.uid()
);

ALTER TABLE "better_supabase"."organization_settings"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."organizations" (
  "id"                 uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "name"               text                     NOT NULL,
  "slug"               text                     NOT NULL,
  "created_by"         uuid,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "disabled_at"        timestamp with time zone,
  "deleted_at"         timestamp with time zone,
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "stripe_customer_id" text,
  CONSTRAINT "bsb_organizations_name_check" CHECK ((length(btrim(name)) > 0)),
  CONSTRAINT "organizations_pkey" PRIMARY KEY (id),
  CONSTRAINT "organizations_stripe_customer_id_key" UNIQUE (stripe_customer_id)
);

ALTER TABLE "better_supabase"."organizations"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."platform_settings" (
  "key"        text                     NOT NULL,
  "value"      jsonb                    NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_platform_settings_key_check" CHECK ((key ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'::text)),
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY (key),
  "updated_by" uuid                     DEFAULT auth.uid()
);

ALTER TABLE "better_supabase"."platform_settings"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."relations" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   uuid                     NOT NULL,
  "kind"        text                     NOT NULL,
  "source_type" text                     NOT NULL,
  "source_id"   text                     NOT NULL,
  "target_type" text                     NOT NULL,
  "target_id"   text                     NOT NULL,
  "data"        jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "created_by"  uuid,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_relations_check" CHECK ((NOT ((source_type = target_type) AND (source_id = target_id)))),
  CONSTRAINT "bsb_relations_data_check" CHECK (((jsonb_typeof(data) = 'object'::text) AND (pg_column_size(data) <= 8192))),
  CONSTRAINT "relations_pkey" PRIMARY KEY (id),
  CONSTRAINT "relations_tenant_id_kind_source_type_source_id_target_type__key" UNIQUE (tenant_id, kind, source_type, source_id, target_type, target_id)
);

ALTER TABLE "better_supabase"."relations"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."scim_group_members" (
  "group_id"     uuid NOT NULL,
  "scim_user_id" uuid NOT NULL,
  CONSTRAINT "scim_group_members_pkey" PRIMARY KEY (group_id, scim_user_id)
);

ALTER TABLE "better_supabase"."scim_group_members"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."scim_groups" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    uuid                     NOT NULL,
  "display_name" text                     NOT NULL,
  "external_id"  text,
  "role"         text,
  "version"      integer                  NOT NULL DEFAULT 1,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_scim_groups_display_name_check" CHECK (((length(display_name) >= 1) AND (length(display_name) <= 256))),
  CONSTRAINT "scim_groups_pkey" PRIMARY KEY (id)
);

ALTER TABLE "better_supabase"."scim_groups"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."scim_users" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    uuid                     NOT NULL,
  "user_id"      uuid,
  "external_id"  text,
  "user_name"    text                     NOT NULL,
  "display_name" text,
  "given_name"   text,
  "family_name"  text,
  "email"        text,
  "emails"       jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "active"       boolean                  NOT NULL DEFAULT true,
  "version"      integer                  NOT NULL DEFAULT 1,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_scim_users_emails_check" CHECK ((jsonb_typeof(emails) = 'array'::text)),
  CONSTRAINT "bsb_scim_users_user_name_check" CHECK (((length(user_name) >= 1) AND (length(user_name) <= 320))),
  CONSTRAINT "scim_users_pkey" PRIMARY KEY (id)
);

ALTER TABLE "better_supabase"."scim_users"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."service_principals" (
  "id"          uuid                     NOT NULL,
  "tenant_id"   uuid                     NOT NULL,
  "name"        text                     NOT NULL,
  "role"        text                     NOT NULL,
  "is_default"  boolean                  NOT NULL DEFAULT false,
  "created_by"  uuid,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "disabled_at" timestamp with time zone,
  CONSTRAINT "bsb_service_principals_name_check" CHECK (((length(name) >= 1) AND (length(name) <= 120))),
  CONSTRAINT "bsb_service_principals_role_check" CHECK (((length(role) >= 1) AND (length(role) <= 200))),
  CONSTRAINT "service_principals_pkey" PRIMARY KEY (id),
  CONSTRAINT "service_principals_tenant_id_name_key" UNIQUE (tenant_id, name)
);

ALTER TABLE "better_supabase"."service_principals"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."ssf_events" (
  "stream_id"  uuid                     NOT NULL,
  "jti"        text                     NOT NULL,
  "token"      text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_ssf_events_jti_check" CHECK (((length(jti) >= 1) AND (length(jti) <= 200))),
  CONSTRAINT "ssf_events_pkey" PRIMARY KEY (stream_id, jti)
);

ALTER TABLE "better_supabase"."ssf_events"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."ssf_received" (
  "issuer"      text                     NOT NULL,
  "jti"         text                     NOT NULL,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_ssf_received_jti_check" CHECK (((length(jti) >= 1) AND (length(jti) <= 200))),
  CONSTRAINT "ssf_received_pkey" PRIMARY KEY (issuer, jti)
);

ALTER TABLE "better_supabase"."ssf_received"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."ssf_streams" (
  "id"               uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant"           text,
  "receiver"         text                     NOT NULL,
  "audience"         text[]                   NOT NULL,
  "description"      text,
  "events_requested" text[]                   NOT NULL DEFAULT '{}'::text[],
  "events_delivered" text[]                   NOT NULL DEFAULT '{}'::text[],
  "delivery_method"  text                     NOT NULL,
  "endpoint_id"      uuid,
  "status"           text                     NOT NULL DEFAULT 'enabled'::text,
  "reason"           text,
  "verified_at"      timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_ssf_streams_audience_check" CHECK (((cardinality(audience) >= 1) AND (cardinality(audience) <= 20))),
  CONSTRAINT "bsb_ssf_streams_delivery_method_check" CHECK ((delivery_method = ANY (ARRAY['urn:ietf:rfc:8935'::text, 'urn:ietf:rfc:8936'::text]))),
  CONSTRAINT "bsb_ssf_streams_description_check" CHECK ((length(description) <= 1000)),
  CONSTRAINT "bsb_ssf_streams_reason_check" CHECK ((length(reason) <= 1000)),
  CONSTRAINT "bsb_ssf_streams_receiver_check" CHECK (((length(receiver) >= 1) AND (length(receiver) <= 200))),
  CONSTRAINT "bsb_ssf_streams_status_check" CHECK ((status = ANY (ARRAY['enabled'::text, 'paused'::text, 'disabled'::text]))),
  CONSTRAINT "bsb_ssf_streams_tenant_check" CHECK (((length(tenant) >= 1) AND (length(tenant) <= 200))),
  CONSTRAINT "ssf_streams_pkey" PRIMARY KEY (id)
);

ALTER TABLE "better_supabase"."ssf_streams"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."sso_domains" (
  "id"                 uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"          uuid                     NOT NULL,
  "domain"             text                     NOT NULL,
  "verification_token" text                     NOT NULL DEFAULT replace((gen_random_uuid())::text, '-'::text, ''::text),
  "verified_at"        timestamp with time zone,
  "auto_join_role"     text,
  "enforce_sso"        boolean                  NOT NULL DEFAULT false,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_sso_domains_auto_join_role_check" CHECK ((auto_join_role = ANY (ARRAY['admin'::text, 'member'::text]))),
  CONSTRAINT "bsb_sso_domains_check" CHECK (((NOT enforce_sso) OR (verified_at IS NOT NULL))),
  CONSTRAINT "bsb_sso_domains_domain_check" CHECK ((domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$'::text)),
  CONSTRAINT "sso_domains_pkey" PRIMARY KEY (id),
  CONSTRAINT "sso_domains_tenant_id_domain_key" UNIQUE (tenant_id, DOMAIN),
  "created_by"         uuid                     DEFAULT auth.uid()
);

ALTER TABLE "better_supabase"."sso_domains"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."sso_providers" (
  "id"           uuid                     NOT NULL,
  "tenant_id"    uuid                     NOT NULL,
  "type"         text                     NOT NULL DEFAULT 'saml'::text,
  "metadata_url" text,
  "domains"      text[]                   NOT NULL DEFAULT '{}'::text[],
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_sso_providers_type_check" CHECK ((type = 'saml'::text)),
  CONSTRAINT "sso_providers_pkey" PRIMARY KEY (id)
);

ALTER TABLE "better_supabase"."sso_providers"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."support_requests" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "admin_id"     uuid                     NOT NULL,
  "target_id"    uuid                     NOT NULL,
  "reason"       text                     NOT NULL,
  "tenant_id"    uuid,
  "read_only"    boolean                  NOT NULL DEFAULT true,
  "metadata"     jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"   timestamp with time zone NOT NULL,
  "approved_by"  uuid,
  "approved_at"  timestamp with time zone,
  "session_id"   uuid,
  CONSTRAINT "bsb_support_requests_check1" CHECK (((approved_by IS NULL) = (approved_at IS NULL))),
  CONSTRAINT "bsb_support_requests_check" CHECK ((admin_id <> target_id)),
  CONSTRAINT "bsb_support_requests_distinct_approver" CHECK ((approved_by <> admin_id)),
  CONSTRAINT "support_requests_pkey" PRIMARY KEY (id)
);

ALTER TABLE "better_supabase"."support_requests"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."support_sessions" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "admin_id"   uuid,
  "target_id"  uuid,
  "reason"     text                     NOT NULL,
  "tenant_id"  uuid,
  "read_only"  boolean                  NOT NULL DEFAULT true,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "ended_at"   timestamp with time zone,
  "ended_by"   text,
  "metadata"   jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "bsb_support_sessions_check1" CHECK ((expires_at > started_at)),
  CONSTRAINT "bsb_support_sessions_check" CHECK ((admin_id <> target_id)),
  CONSTRAINT "bsb_support_sessions_ended_by_check" CHECK ((ended_by = ANY (ARRAY['admin'::text, 'expired'::text, 'revoked'::text]))),
  CONSTRAINT "support_sessions_pkey" PRIMARY KEY (id)
);

ALTER TABLE "better_supabase"."support_sessions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."team_members" (
  "team_id"    uuid                     NOT NULL,
  "user_id"    uuid                     NOT NULL,
  "tenant_id"  uuid                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "team_members_pkey" PRIMARY KEY (team_id, user_id)
);

ALTER TABLE "better_supabase"."team_members"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."teams" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   uuid                     NOT NULL,
  "name"        text                     NOT NULL,
  "slug"        text                     NOT NULL,
  "description" text,
  "status"      text                     NOT NULL DEFAULT 'active'::text,
  "created_by"  uuid,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_teams_name_check" CHECK (((length(name) >= 1) AND (length(name) <= 200))),
  CONSTRAINT "bsb_teams_slug_check" CHECK ((slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text)),
  CONSTRAINT "bsb_teams_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
  CONSTRAINT "teams_pkey" PRIMARY KEY (id),
  CONSTRAINT "teams_tenant_id_slug_key" UNIQUE (tenant_id, slug)
);

ALTER TABLE "better_supabase"."teams"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."usage_counters" (
  "tenant_id"      uuid                     NOT NULL,
  "meter"          text                     NOT NULL,
  "day"            date                     NOT NULL,
  "value"          numeric                  NOT NULL DEFAULT 0,
  "reported_value" numeric                  NOT NULL DEFAULT 0,
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_usage_counters_meter_check" CHECK ((meter ~ '^[a-z][a-z0-9_.:-]{0,63}$'::text)),
  CONSTRAINT "bsb_usage_counters_reported_value_check" CHECK ((reported_value >= (0)::numeric)),
  CONSTRAINT "bsb_usage_counters_value_check" CHECK ((value >= (0)::numeric)),
  CONSTRAINT "usage_counters_pkey" PRIMARY KEY (tenant_id, meter, day)
);

ALTER TABLE "better_supabase"."usage_counters"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."usage_events" (
  "tenant_id"       uuid                     NOT NULL,
  "meter"           text                     NOT NULL,
  "idempotency_key" text                     NOT NULL,
  "quantity"        numeric                  NOT NULL,
  "recorded_at"     timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "usage_events_pkey" PRIMARY KEY (tenant_id, meter, idempotency_key)
);

ALTER TABLE "better_supabase"."usage_events"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."usage_quotas" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"  uuid,
  "plan"       text,
  "meter"      text                     NOT NULL,
  "limit"      numeric,
  "period"     text                     NOT NULL DEFAULT 'month'::text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_usage_quotas_check" CHECK (((tenant_id IS NULL) <> (plan IS NULL))),
  CONSTRAINT "bsb_usage_quotas_limit_check" CHECK (("limit" >= (0)::numeric)),
  CONSTRAINT "bsb_usage_quotas_meter_check" CHECK ((meter ~ '^[a-z][a-z0-9_.:-]{0,63}$'::text)),
  CONSTRAINT "bsb_usage_quotas_period_check" CHECK ((period = ANY (ARRAY['day'::text, 'week'::text, 'month'::text, 'year'::text, 'billing'::text]))),
  CONSTRAINT "usage_quotas_pkey" PRIMARY KEY (id),
  CONSTRAINT "usage_quotas_tenant_id_plan_meter_key" UNIQUE NULLS NOT DISTINCT (tenant_id, plan, meter)
);

ALTER TABLE "better_supabase"."usage_quotas"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "better_supabase"."user_settings" (
  "user_id"    uuid                     NOT NULL,
  "key"        text                     NOT NULL,
  "value"      jsonb                    NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bsb_user_settings_key_check" CHECK ((key ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'::text)),
  CONSTRAINT "user_settings_pkey" PRIMARY KEY (user_id, key),
  "updated_by" uuid                     DEFAULT auth.uid()
);

ALTER TABLE "better_supabase"."user_settings"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."quotes"
  ADD COLUMN "status" text NOT NULL DEFAULT 'draft'::text;

ALTER TABLE "public"."quotes"
  ADD COLUMN "team_id" uuid;

CREATE OR REPLACE FUNCTION better_supabase.accept_invitation (
  token text
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
  invite "better_supabase"."invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if me is null then
    raise exception 'Sign in to accept an invitation' using errcode = '42501', hint = 'INVITATION_SIGN_IN';
  end if;
  select * into invite
  from "better_supabase"."invitations" i
  where i."token_hash" = encode(extensions.digest(token, 'sha256'), 'hex')
  for update;
  if invite."id" is null then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if not (invite."accepted_at" is null and invite."declined_at" is null and invite."revoked_at" is null) then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if invite."expires_at" < now() then
    raise exception 'The invitation has expired; ask for a new one' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
  end if;
  if lower(invite."email") <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'The invitation is for another email address' using errcode = '42501', hint = 'INVITATION_EMAIL_MISMATCH';
  end if;
  -- The email claim alone does not prove the address: an unconfirmed sign-up carries it too.
  if not exists (
    select 1 from auth.users u
    where u.id = me and u.email_confirmed_at is not null and lower(u.email) = lower(invite."email")
  ) then
    raise exception 'Confirm your email address before accepting the invitation' using errcode = '42501', hint = 'INVITATION_EMAIL_UNCONFIRMED';
  end if;
  if invite."invited_by" = me then
    raise exception 'You cannot accept your own invitation' using errcode = '42501', hint = 'INVITATION_SELF';
  end if;
  if better_supabase.tenant_disabled(invite."tenant_id") or not exists (select 1 from "better_supabase"."organizations" o where o."id" = invite."tenant_id") then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if exists (select 1 from "public"."organization_memberships" m where m."organization_id" = invite."tenant_id" and m."user_id" = me) then
    raise exception 'You are already a member' using errcode = '23505', hint = 'INVITATION_ALREADY_MEMBER';
  end if;
    if invite."invited_by" is not null
      and better_supabase.can_user(invite."invited_by", 'organization', invite."tenant_id", 'members.invite') is false then
      raise exception 'The person who invited you can no longer invite members' using errcode = '42501', hint = 'INVITATION_INVITER_REVOKED';
    end if;
  perform set_config('better_supabase.accepting_invitation', invite."id"::text, true);
  insert into "public"."organization_memberships" ("organization_id", "user_id", "role")
  values (invite."tenant_id", me, invite."role");
  perform set_config('better_supabase.accepting_invitation', '', true);
  update "better_supabase"."invitations"
  set "accepted_at" = now(), "accepted_by" = me
  where "id" = invite."id";
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_invitation_accept"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using invite."id", me;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'invitation.accepted',
    category => 'membership',
    target_type => 'invitation',
    record_id => invite."id"::text,
    tenant => (invite."tenant_id")::uuid,
    metadata => jsonb_build_object('invitationId', invite."id", 'organizationId', invite."tenant_id"::text, 'email', invite."email", 'role', invite."role")
  );
  perform better_supabase.audit_event(
    event_type => 'organization.member_added',
    category => 'membership',
    target_type => 'user',
    record_id => me::text,
    tenant => (invite."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', invite."tenant_id"::text, 'userId', me, 'role', invite."role")
  );
  return invite."tenant_id";
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.accept_invitation_by_id (
  invitation_id uuid
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
  invite "better_supabase"."invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if me is null then
    raise exception 'Sign in to accept an invitation' using errcode = '42501', hint = 'INVITATION_SIGN_IN';
  end if;
  select * into invite
  from "better_supabase"."invitations" i
  where i."id" = invitation_id
  for update;
  if invite."id" is null then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if not (invite."accepted_at" is null and invite."declined_at" is null and invite."revoked_at" is null) then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if invite."expires_at" < now() then
    raise exception 'The invitation has expired; ask for a new one' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
  end if;
  if lower(invite."email") <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'The invitation is for another email address' using errcode = '42501', hint = 'INVITATION_EMAIL_MISMATCH';
  end if;
  -- The email claim alone does not prove the address: an unconfirmed sign-up carries it too.
  if not exists (
    select 1 from auth.users u
    where u.id = me and u.email_confirmed_at is not null and lower(u.email) = lower(invite."email")
  ) then
    raise exception 'Confirm your email address before accepting the invitation' using errcode = '42501', hint = 'INVITATION_EMAIL_UNCONFIRMED';
  end if;
  if invite."invited_by" = me then
    raise exception 'You cannot accept your own invitation' using errcode = '42501', hint = 'INVITATION_SELF';
  end if;
  if better_supabase.tenant_disabled(invite."tenant_id") or not exists (select 1 from "better_supabase"."organizations" o where o."id" = invite."tenant_id") then
    raise exception 'The invitation is invalid or has expired' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if exists (select 1 from "public"."organization_memberships" m where m."organization_id" = invite."tenant_id" and m."user_id" = me) then
    raise exception 'You are already a member' using errcode = '23505', hint = 'INVITATION_ALREADY_MEMBER';
  end if;
    if invite."invited_by" is not null
      and better_supabase.can_user(invite."invited_by", 'organization', invite."tenant_id", 'members.invite') is false then
      raise exception 'The person who invited you can no longer invite members' using errcode = '42501', hint = 'INVITATION_INVITER_REVOKED';
    end if;
  perform set_config('better_supabase.accepting_invitation', invite."id"::text, true);
  insert into "public"."organization_memberships" ("organization_id", "user_id", "role")
  values (invite."tenant_id", me, invite."role");
  perform set_config('better_supabase.accepting_invitation', '', true);
  update "better_supabase"."invitations"
  set "accepted_at" = now(), "accepted_by" = me
  where "id" = invite."id";
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_invitation_accept"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using invite."id", me;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'invitation.accepted',
    category => 'membership',
    target_type => 'invitation',
    record_id => invite."id"::text,
    tenant => (invite."tenant_id")::uuid,
    metadata => jsonb_build_object('invitationId', invite."id", 'organizationId', invite."tenant_id"::text, 'email', invite."email", 'role', invite."role")
  );
  perform better_supabase.audit_event(
    event_type => 'organization.member_added',
    category => 'membership',
    target_type => 'user',
    record_id => me::text,
    tenant => (invite."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', invite."tenant_id"::text, 'userId', me, 'role', invite."role")
  );
  return invite."tenant_id";
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.accepting_invitation()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select nullif(current_setting('better_supabase.accepting_invitation', true), '')::uuid
$function$;

CREATE OR REPLACE FUNCTION better_supabase.active_support_session (
  session_id uuid,
  admin_id   uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  )
  from "better_supabase"."support_sessions" s
  where s."id" = $1
    and s."ended_at" is null
    and s."expires_at" > now()
    and case when coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') then s."admin_id" = $2
      else s."admin_id" = auth.uid() and "better_supabase"."is_platform"('impersonation.start')
    end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.add_organization_domain (
  tenant uuid,
  domain text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_row "better_supabase"."sso_domains";
  v_domain text := lower(trim(trailing '.' from trim(add_organization_domain.domain)));
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not coalesce(better_supabase.can('tenant', add_organization_domain.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s domains' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]{2,63}$' then
    raise exception 'Not a domain name: %', add_organization_domain.domain using errcode = '22023', hint = 'SSO_DOMAIN_INVALID';
  end if;
  insert into "better_supabase"."sso_domains" as x ("tenant_id", "domain") values (add_organization_domain.tenant, v_domain)
  on conflict ("tenant_id", "domain") do update set "domain" = x."domain"
  returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'sso_domain.created',
    category => 'security',
    target_type => 'domain',
    record_id => v_row."id"::text,
    target_label => v_row."domain",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'domainId', v_row."id", 'domain', v_row."domain", 'userId', auth.uid()),
    actor_id => auth.uid()
  );
  return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.add_team_member (
  team   uuid,
  member uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select "tenant_id" into v_tenant from "better_supabase"."teams" where "id" = add_team_member.team;
  if not found then
    raise exception 'team not found' using errcode = 'P0002', hint = 'TEAM_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'teams.manage'), false)) then
    raise exception 'not allowed to manage teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  if not exists (
    select 1 from "public"."organization_memberships" m
    where m."organization_id" = v_tenant
      and m."user_id" = add_team_member.member
  ) then
    raise exception 'user is not a member of the tenant' using errcode = '22023', hint = 'TEAM_MEMBER_INVALID';
  end if;
  insert into "better_supabase"."team_members" ("team_id", "user_id", "tenant_id")
  values (add_team_member.team, add_team_member.member, v_tenant)
  on conflict do nothing;
  perform better_supabase.audit_event(
    event_type => 'team_member.added',
    category => 'membership',
    target_type => 'team',
    record_id => (add_team_member.team)::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant, 'id', add_team_member.team, 'userId', add_team_member.member)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.ancestors (
  tenant       uuid,
  kind         text,
  subject_type text,
  subject_id   text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('type', w.type, 'id', w.id, 'depth', w.depth) order by w.depth, w.type, w.id), '[]'::jsonb)
  from "better_supabase"."relation_walk"(ancestors.tenant, ancestors.kind, ancestors.subject_type, ancestors.subject_id, true, null) w
$function$;

CREATE OR REPLACE FUNCTION better_supabase.api_key_tenant()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select nullif(auth.jwt() -> 'api_key' ->> 'organization_id', '')::uuid
$function$;

CREATE OR REPLACE FUNCTION better_supabase.apply_support_approval (
  request_id uuid,
  approver   uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_row "better_supabase"."support_requests";
begin
  select * into v_row from "better_supabase"."support_requests" x where x."id" = request_id for update;
  if not found then
    raise exception 'No support request %', request_id using errcode = 'P0002', hint = 'IMPERSONATION_REQUEST_MISSING';
  end if;
  if approver is null then
    raise exception 'Not allowed to approve a support session' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
  end if;
  if v_row."admin_id" = approver then
    raise exception 'An admin cannot approve their own support session' using errcode = '42501', hint = 'IMPERSONATION_SELF_APPROVAL';
  end if;
  if v_row."approved_by" is not null then
    if v_row."approved_by" = approver then
      return jsonb_build_object(
    'id', v_row."id",
    'admin_id', v_row."admin_id",
    'target_user_id', v_row."target_id",
    'reason', v_row."reason",
    'tenant', v_row."tenant_id",
    'read_only', v_row."read_only",
    'metadata', v_row."metadata",
    'requested_at', v_row."requested_at",
    'expires_at', v_row."expires_at",
    'approved_by', v_row."approved_by",
    'approved_at', v_row."approved_at",
    'session_id', v_row."session_id"
  );
    end if;
    raise exception 'Support request % is already approved', request_id using errcode = 'P0001', hint = 'IMPERSONATION_REQUEST_DECIDED';
  end if;
  if v_row."session_id" is not null or v_row."expires_at" <= now() then
    raise exception 'Support request % has expired or was used', request_id using errcode = 'P0001', hint = 'IMPERSONATION_REQUEST_CLOSED';
  end if;
  update "better_supabase"."support_requests" x set "approved_by" = approver, "approved_at" = now()
  where x."id" = request_id
  returning * into v_row;
  perform "better_supabase"."approval_settle"('support_request', request_id::text, 'start', 'approved', approver);
  return jsonb_build_object(
    'id', v_row."id",
    'admin_id', v_row."admin_id",
    'target_user_id', v_row."target_id",
    'reason', v_row."reason",
    'tenant', v_row."tenant_id",
    'read_only', v_row."read_only",
    'metadata', v_row."metadata",
    'requested_at', v_row."requested_at",
    'expires_at', v_row."expires_at",
    'approved_by', v_row."approved_by",
    'approved_at', v_row."approved_at",
    'session_id', v_row."session_id"
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_effective_policy (
  tenant       uuid,
  subject_type text,
  action       text,
  subject      jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select "better_supabase"."approval_policy"(approval_effective_policy.subject_type, approval_effective_policy.action)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_eligible (
  request better_supabase.approval_requests
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_req "better_supabase"."approval_requests"%rowtype := approval_eligible.request;
  v_step jsonb;
  v_approvers jsonb;
  v_me uuid := auth.uid();
begin
  if v_req."id" is null or v_me is null or v_req."status" <> 'pending' then
    return false;
  end if;
  if exists (
    select 1 from "better_supabase"."approval_decisions" x
    where x."request_id" = v_req."id" and x."step" = v_req."step" and x."approver" = v_me
  ) then
    return false;
  end if;
  if coalesce(v_req."policy" -> 'excludedUserIds', '[]'::jsonb) ? v_me::text then
    return false;
  end if;
  if v_me = v_req."requested_by" then
    if v_req."policy" ->> 'mode' = 'confirm' then
      return true;
    end if;
    if not coalesce((v_req."policy" ->> 'selfApproval')::boolean, false) then
      return false;
    end if;
  end if;
  if v_req."subject_type" = 'support_request' then
    return "better_supabase"."support_request_approvable"(v_req."subject_id"::uuid);
  end if;
  v_step := v_req."policy" -> 'steps' -> v_req."step";
  v_approvers := v_step -> 'approvers';
  if ((coalesce(v_approvers -> 'users', '[]'::jsonb) ? v_me::text)
    or (v_approvers ->> 'permission' is not null and coalesce(better_supabase.can('tenant', v_req."tenant_id", v_approvers ->> 'permission'), false))
    or (v_approvers ->> 'role' is not null and "better_supabase"."approval_fact"(v_req."tenant_id", 'role', v_approvers ->> 'role', null))
    or (v_approvers ->> 'team' is not null and "better_supabase"."approval_fact"(v_req."tenant_id", 'team', v_approvers ->> 'team', null))) then
    return true;
  end if;
  if coalesce((v_step ->> 'escalated')::boolean, false) then
    v_approvers := v_step -> 'escalateTo';
    if ((coalesce(v_approvers -> 'users', '[]'::jsonb) ? v_me::text)
    or (v_approvers ->> 'permission' is not null and coalesce(better_supabase.can('tenant', v_req."tenant_id", v_approvers ->> 'permission'), false))
    or (v_approvers ->> 'role' is not null and "better_supabase"."approval_fact"(v_req."tenant_id", 'role', v_approvers ->> 'role', null))
    or (v_approvers ->> 'team' is not null and "better_supabase"."approval_fact"(v_req."tenant_id", 'team', v_approvers ->> 'team', null))) then
      return true;
    end if;
  end if;
  return exists (
      select 1 from "better_supabase"."approval_decisions" x
      where x."request_id" = v_req."id" and x."step" = v_req."step"
        and x."decision" = 'delegated' and x."delegate_to" = v_me
    );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_eligible (
  request_id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = approval_eligible.request_id;
  if not found then
    return false;
  end if;
  return "better_supabase"."approval_eligible"(v_req);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_eligible_ids (
  tenant uuid DEFAULT NULL::uuid
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  return query
  with base as (
    select r.*, (select auth.uid()) as bsb_me from "better_supabase"."approval_requests" r
    where r."status" = 'pending' and (select auth.uid()) is not null
      and (approval_eligible_ids.tenant is null or r."tenant_id" = approval_eligible_ids.tenant)
  ),
  q as (
    select b.*, b."policy" -> 'steps' -> b."step" as bsb_step from base b
  ),
  needs as materialized (
    select distinct q."tenant_id" as t, s.ap ->> 'permission' as p
    from q, lateral (values ((q.bsb_step -> 'approvers'), (case when coalesce((q.bsb_step ->> 'escalated')::boolean, false) then (q.bsb_step -> 'escalateTo') end))) as s(ap)
    where s.ap ->> 'permission' is not null
  ),
  granted as materialized (
    select n.t, n.p from needs n
    where coalesce(better_supabase.can('tenant', n.t, n.p), false)
  )
  select q."id" from q
  where not exists (select 1 from "better_supabase"."approval_decisions" x where x."request_id" = q."id" and x."step" = q."step" and x."approver" = q.bsb_me)
    and not (coalesce(q."policy" -> 'excludedUserIds', '[]'::jsonb) ? q.bsb_me::text)
    and ((q.bsb_me = q."requested_by" and q."policy" ->> 'mode' = 'confirm')
      or ((q.bsb_me is distinct from q."requested_by" or coalesce((q."policy" ->> 'selfApproval')::boolean, false))
        and (case when q."subject_type" = 'support_request' then ("better_supabase"."support_request_approvable"(q."subject_id"::uuid))
          else (((coalesce((q.bsb_step -> 'approvers') -> 'users', '[]'::jsonb) ? q.bsb_me::text)
    or ((q.bsb_step -> 'approvers') ->> 'permission' is not null and exists (select 1 from granted g where g.t is not distinct from q."tenant_id" and g.p = (q.bsb_step -> 'approvers') ->> 'permission'))
    or ((q.bsb_step -> 'approvers') ->> 'role' is not null and exists (
      select 1 from "public"."organization_memberships" mm
      where mm."organization_id" = q."tenant_id" and mm."user_id" = q.bsb_me and mm."role" = (q.bsb_step -> 'approvers') ->> 'role'
    ))
    or ((q.bsb_step -> 'approvers') ->> 'team' is not null and exists (select 1 from "better_supabase"."team_members" tm where tm."team_id"::text = (q.bsb_step -> 'approvers') ->> 'team' and tm."user_id" = q.bsb_me)))
    or (coalesce((q.bsb_step ->> 'escalated')::boolean, false) and ((coalesce((q.bsb_step -> 'escalateTo') -> 'users', '[]'::jsonb) ? q.bsb_me::text)
    or ((q.bsb_step -> 'escalateTo') ->> 'permission' is not null and exists (select 1 from granted g where g.t is not distinct from q."tenant_id" and g.p = (q.bsb_step -> 'escalateTo') ->> 'permission'))
    or ((q.bsb_step -> 'escalateTo') ->> 'role' is not null and exists (
      select 1 from "public"."organization_memberships" mm
      where mm."organization_id" = q."tenant_id" and mm."user_id" = q.bsb_me and mm."role" = (q.bsb_step -> 'escalateTo') ->> 'role'
    ))
    or ((q.bsb_step -> 'escalateTo') ->> 'team' is not null and exists (select 1 from "better_supabase"."team_members" tm where tm."team_id"::text = (q.bsb_step -> 'escalateTo') ->> 'team' and tm."user_id" = q.bsb_me))))
    or exists (select 1 from "better_supabase"."approval_decisions" x where x."request_id" = q."id" and x."step" = q."step" and x."decision" = 'delegated' and x."delegate_to" = q.bsb_me)) end)));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_fact (
  tenant    uuid,
  kind      text,
  value     text,
  requester uuid DEFAULT NULL::uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_me uuid := auth.uid();
  v_key text := 'approvals.f' || md5(format('%s|%s|%s|%s|%s', v_me, approval_fact.tenant, approval_fact.kind, approval_fact.value, approval_fact.requester));
  v_stamp text := statement_timestamp()::text || '/' || coalesce(better_supabase.memo_get('approvals.gen'), '0');
  v_hit text := better_supabase.memo_slot_get(v_key);
  v_result boolean;
begin
  if v_hit is not null and split_part(v_hit, '|', 1) = v_stamp then
    return split_part(v_hit, '|', 2) = 't';
  end if;
  v_result := coalesce(case approval_fact.kind
    when 'role' then exists (
      select 1 from "public"."organization_memberships" m
      where m."organization_id" = approval_fact.tenant and m."user_id" = v_me and m."role" = approval_fact.value
    )
    when 'team' then exists (select 1 from "better_supabase"."team_members" tm where tm."team_id"::text = approval_fact.value and tm."user_id" = v_me)
    when 'manager' then false
    else false
  end, false);
  perform better_supabase.memo_slot_set(v_key, v_stamp || '|' || case when v_result then 't' else 'f' end);
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_finalize (
  request_id uuid
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_run jsonb;
begin
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = approval_finalize.request_id;
  v_run := v_req."policy" -> 'run';
  if v_req."subject_type" = 'support_request' then
    perform "better_supabase"."apply_support_approval"(v_req."subject_id"::uuid, auth.uid());
  end if;
  if v_req."subject_type" = 'access_request' then
    perform "better_supabase"."grant_access_request"(v_req."subject_id"::uuid);
  end if;
  perform better_supabase.audit_event(
    event_type => 'approval.approved',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'approved' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  perform "better_supabase"."approval_notify"(v_req."id", 'approved');
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_memo_bump()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform better_supabase.memo_set('approvals.gen', (coalesce(better_supabase.memo_get('approvals.gen'), '0')::bigint + 1)::text);
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_notify (
  request_id uuid,
  kind       text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_approvers jsonb;
  v_permission text;
  v_recipients uuid[] := '{}';
  v_claims text;
begin
  null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_policy (
  subject_type text,
  action       text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(
    better_supabase.declared_defaults_of('approval_floor', approval_policy.subject_type || ':' || approval_policy.action) -> 0,
    better_supabase.declared_defaults_of('approval_floor', approval_policy.subject_type || ':*') -> 0,
    better_supabase.declared_defaults_of('approval_floor', '*:' || approval_policy.action) -> 0,
    better_supabase.declared_defaults_of('approval_floor', '*:*') -> 0,
    null::jsonb
  )
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_policy_tighten (
  base jsonb,
  own  jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_step jsonb;
  v_who jsonb;
  v_mode text := coalesce(approval_policy_tighten.own ->> 'mode', 'authorize');
  v_steps jsonb := coalesce(approval_policy_tighten.own -> 'steps', '[]'::jsonb);
  v_level integer;
  v_expires interval;
begin
  if jsonb_typeof(approval_policy_tighten.own) is distinct from 'object'
    or jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) > 20
    or v_mode not in ('confirm', 'authorize')
    or (approval_policy_tighten.own ? 'selfApproval' and jsonb_typeof(approval_policy_tighten.own -> 'selfApproval') <> 'boolean')
    or (approval_policy_tighten.own ? 'managerOf' and true)
    or (approval_policy_tighten.own ->> 'expiresIn' is not null and (approval_policy_tighten.own ->> 'expiresIn')::interval <= interval '0') then
    raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
  end if;
  for v_step in select * from jsonb_array_elements(v_steps) loop
    if jsonb_typeof(v_step) <> 'object' then
      raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
    end if;
    for v_who in select a.w from (values (v_step -> 'approvers', true), (v_step -> 'escalateTo', v_step ? 'escalateTo')) a(w, checked) where a.checked loop
      if jsonb_typeof(v_who) is distinct from 'object'
        or not (v_who ?| array['permission', 'role', 'team', 'users', 'manager', 'decider'])
        or (v_who ? 'manager' and true)
        or (v_who ? 'decider' and v_who -> 'decider' <> 'true'::jsonb)
        or (v_who ? 'users' and (jsonb_typeof(v_who -> 'users') <> 'array'
          or exists (select 1 from jsonb_array_elements(v_who -> 'users') u
            where jsonb_typeof(u) <> 'string' or u #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))) then
        raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
      end if;
    end loop;
    if (v_step ? 'required' and v_step -> 'required' <> '"all"'::jsonb and (jsonb_typeof(v_step -> 'required') <> 'number' or (v_step ->> 'required')::numeric < 1
        or (v_step ->> 'required')::numeric <> trunc((v_step ->> 'required')::numeric)))
      or (v_step -> 'required' = '"all"'::jsonb and (v_step -> 'approvers') - 'permission' <> '{}'::jsonb
        and ((v_step -> 'approvers') - 'users' <> '{}'::jsonb or jsonb_array_length(v_step -> 'approvers' -> 'users') = 0))
      or (jsonb_typeof(v_step -> 'required') = 'number' and (v_step -> 'approvers') - 'users' = '{}'::jsonb
        and (v_step ->> 'required')::numeric > jsonb_array_length(v_step -> 'approvers' -> 'users'))
      or ((v_step ? 'escalateAfter') <> (v_step ? 'escalateTo'))
      or (v_step ? 'escalateAfter' and (jsonb_typeof(v_step -> 'escalateAfter') <> 'string' or (v_step ->> 'escalateAfter')::interval <= interval '0')) then
      raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
    end if;
  end loop;
  v_steps := (select coalesce(jsonb_agg(case when s -> 'required' = '"all"'::jsonb and (s -> 'approvers') ? 'users'
    then jsonb_set(s, '{required}', to_jsonb(jsonb_array_length(s -> 'approvers' -> 'users'))) || '{"all": true}'::jsonb else s - 'all' end order by o), '[]'::jsonb)
    from jsonb_array_elements(v_steps) with ordinality e(s, o));
  v_expires := (approval_policy_tighten.own ->> 'expiresIn')::interval;
  if approval_policy_tighten.base is null then
    return jsonb_build_object(
      'steps', v_steps,
      'selfApproval', coalesce((approval_policy_tighten.own ->> 'selfApproval')::boolean, false),
      'expiresIn', v_expires::text, 'run', null
    ) || case when v_mode = 'confirm' then '{"mode": "confirm"}'::jsonb else '{}'::jsonb end
      || case when approval_policy_tighten.own ? 'managerOf' then jsonb_build_object('managerOf', approval_policy_tighten.own -> 'managerOf') else '{}'::jsonb end;
  end if;
  v_level := greatest(
    case when coalesce(approval_policy_tighten.base ->> 'mode', 'authorize') = 'authorize' and jsonb_array_length(coalesce(approval_policy_tighten.base -> 'steps', '[]'::jsonb)) > 0 then 2 when coalesce(approval_policy_tighten.base ->> 'mode', 'authorize') = 'confirm' then 1 else 0 end,
    case when v_mode = 'authorize' and jsonb_array_length(v_steps) > 0 then 2 when v_mode = 'confirm' then 1 else 0 end
  );
  return approval_policy_tighten.base || jsonb_build_object(
    'steps', coalesce(approval_policy_tighten.base -> 'steps', '[]'::jsonb) || v_steps,
    'selfApproval', coalesce((approval_policy_tighten.base ->> 'selfApproval')::boolean, false) and coalesce((approval_policy_tighten.own ->> 'selfApproval')::boolean, false),
    'expiresIn', least((approval_policy_tighten.base ->> 'expiresIn')::interval, v_expires)::text,
    'mode', case when v_level = 1 then 'confirm' else 'authorize' end
  ) || case when approval_policy_tighten.own ? 'managerOf' then jsonb_build_object('managerOf', approval_policy_tighten.own -> 'managerOf') else '{}'::jsonb end;
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'policy must be { steps: [{ approvers: { permission, role, team, users, decider }, required, escalateAfter, escalateTo }], mode, selfApproval, expiresIn }' using errcode = '22023', hint = 'APPROVAL_POLICY_INVALID';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_requirement (
  tenant       uuid,
  subject_type text,
  action       text,
  subject      jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_policy jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', approval_requirement.tenant, 'approvals.request'), false)) then
    raise exception 'checking an approval requirement needs approvals.request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  v_policy := "better_supabase"."approval_effective_policy"(approval_requirement.tenant, approval_requirement.subject_type, approval_requirement.action, approval_requirement.subject);
  if v_policy is null or not (coalesce(v_policy ->> 'mode', 'authorize') = 'confirm' or jsonb_array_length(coalesce(v_policy -> 'steps', '[]'::jsonb)) > 0) then
    return null;
  end if;
  return v_policy || jsonb_build_object('mode', coalesce(v_policy ->> 'mode', 'authorize'));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approval_settle (
  subject_type text,
  subject_id   text,
  action       text,
  decision     text,
  approver     uuid,
  comment      text DEFAULT NULL::text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  select * into v_req from "better_supabase"."approval_requests" r
  where r."subject_type" = approval_settle.subject_type and r."subject_id" = approval_settle.subject_id
    and r."action" = approval_settle.action and r."status" = 'pending'
  for update;
  if not found then
    return;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", approval_settle.decision;
    end if;
  end;
  insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision", "comment")
  values (v_req."id", v_req."tenant_id", v_req."step", approval_settle.approver, approval_settle.decision, approval_settle.comment)
  on conflict do nothing;
  update "better_supabase"."approval_requests" r set "status" = approval_settle.decision, "decided_at" = now()
    where r."id" = v_req."id" returning * into v_req;
  if approval_settle.decision = 'approved' then
    perform better_supabase.audit_event(
    event_type => 'approval.approved',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'approved' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  else
    perform better_supabase.audit_event(
    event_type => 'approval.rejected',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'rejected' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  end if;
  perform "better_supabase"."approval_notify"(v_req."id", approval_settle.decision);
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_req."status";
    end if;
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approve_support_request (
  request_id  uuid,
  approver_id uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  approver uuid;
  v_row "better_supabase"."support_requests";
begin
  perform better_supabase.raise_actor_readonly() where not (permdock.permdock_actor_may_write());
  if service then
    approver := approver_id;
    if approver is null then
      raise exception 'approver_id is required for the service role' using errcode = '22023', hint = 'IMPERSONATION_FORBIDDEN';
    end if;
  else
    approver := auth.uid();
    if approver is null or (approver_id is not null and approver_id <> approver) then
      raise exception 'Not allowed to approve a support session' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
    end if;
  end if;
  select * into v_row from "better_supabase"."support_requests" x where x."id" = request_id for update;
  if not found then
    raise exception 'No support request %', request_id using errcode = 'P0002', hint = 'IMPERSONATION_REQUEST_MISSING';
  end if;
  if v_row."admin_id" = approver then
    raise exception 'An admin cannot approve their own support session' using errcode = '42501', hint = 'IMPERSONATION_SELF_APPROVAL';
  end if;
  if not service and not "better_supabase"."is_platform"('impersonation.start') then
    raise exception 'Not allowed to approve this support session' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
  end if;
  return "better_supabase"."apply_support_approval"(request_id, approver);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.approved_support_request (
  target    uuid,
  tenant    uuid    DEFAULT NULL::uuid,
  read_only boolean DEFAULT true,
  admin_id  uuid    DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'id', x."id",
    'admin_id', x."admin_id",
    'target_user_id', x."target_id",
    'reason', x."reason",
    'tenant', x."tenant_id",
    'read_only', x."read_only",
    'metadata', x."metadata",
    'requested_at', x."requested_at",
    'expires_at', x."expires_at",
    'approved_by', x."approved_by",
    'approved_at', x."approved_at",
    'session_id', x."session_id"
  )
  from "better_supabase"."support_requests" x
  where x."admin_id" = case when coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') then $4 else auth.uid() end
    and x."target_id" = $1
    and x."tenant_id" is not distinct from $2
    and (not x."read_only" or coalesce($3, true))
    and x."approved_by" is not null
    and x."approved_by" <> case when coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') then $4 else auth.uid() end
    and x."session_id" is null
    and x."expires_at" > now()
  order by x."approved_at" desc
  limit 1
$function$;

CREATE OR REPLACE FUNCTION better_supabase.archive_team (
  team uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select "tenant_id" into v_tenant from "better_supabase"."teams" where "id" = archive_team.team;
  if not found then
    raise exception 'team not found' using errcode = 'P0002', hint = 'TEAM_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'teams.manage'), false)) then
    raise exception 'not allowed to manage teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  update "better_supabase"."teams" set "status" = 'archived', "updated_at" = now() where "id" = archive_team.team;
  perform better_supabase.audit_event(
    event_type => 'team.archived',
    category => 'membership',
    target_type => 'team',
    record_id => (archive_team.team)::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant, 'id', archive_team.team)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event (
  event_type           text,
  category             text  DEFAULT NULL::text,
  outcome              text  DEFAULT 'success'::text,
  source               text  DEFAULT NULL::text,
  target_type          text  DEFAULT NULL::text,
  record_id            text  DEFAULT NULL::text,
  tenant               uuid  DEFAULT NULL::uuid,
  metadata             jsonb DEFAULT '{}'::jsonb,
  idempotency_key      text  DEFAULT NULL::text,
  restricted           jsonb DEFAULT NULL::jsonb,
  actor_id             uuid  DEFAULT NULL::uuid,
  summary              text  DEFAULT NULL::text,
  target_label         text  DEFAULT NULL::text,
  correlation_id       text  DEFAULT NULL::text,
  actor_kind           text  DEFAULT NULL::text,
  actor_label          text  DEFAULT NULL::text,
  ip                   inet  DEFAULT NULL::inet,
  user_agent           text  DEFAULT NULL::text,
  session_id           text  DEFAULT NULL::text,
  request_id           text  DEFAULT NULL::text,
  scope                text  DEFAULT NULL::text,
  support_session      uuid  DEFAULT NULL::uuid,
  impersonated_by      uuid  DEFAULT NULL::uuid,
  impersonation_reason text  DEFAULT NULL::text,
  summary_key          text  DEFAULT NULL::text,
  summary_params       jsonb DEFAULT NULL::jsonb
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  existing text;
  v_integration boolean := better_supabase.import_run() is not null;
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if restricted is not null or ip is not null or user_agent is not null or session_id is not null then
    raise exception 'audit_event got restricted details, and the audit module has no restricted table'
      using errcode = '22023', hint = 'Set blocks.audit.options.restricted to true.';
  end if;
  -- imports.audit 'summary' (ADR 0141): the run audits per entity at its end.
  if v_integration and current_setting('better_supabase.import_audit', true) = 'summary' then
    return null;
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    actor_id := auth.uid();
    actor_kind := null;
    actor_label := null;
    ip := null;
    user_agent := null;
    session_id := null;
    request_id := null;
    scope := null;
    if (select auth.jwt()) -> 'act' is not null or impersonated_by is distinct from auth.uid() then
      support_session := null;
      impersonated_by := null;
      impersonation_reason := null;
    end if;
  elsif actor_id is null then
    actor_id := coalesce(auth.uid(), better_supabase.acting_member());
  end if;
  if idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('better_supabase.audit_event'), pg_catalog.hashtext(coalesce(tenant::text, '') || ':' || idempotency_key));
    select l."id"::text into existing
    from "better_supabase"."audit_events" l
    where l."idempotency_key" = audit_event.idempotency_key
      and l."tenant_id" is not distinct from audit_event.tenant
    limit 1;
    if existing is not null then
      return existing;
    end if;
  end if;
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
  values (
    null,
    record_id,
    'event',
    actor_id,
    coalesce(auth.jwt() ->> 'role', current_user),
    tenant,
    coalesce(audit_event.impersonated_by, case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end),
    coalesce(audit_event.impersonation_reason, auth.jwt() -> 'act' ->> 'reason'),
    coalesce(audit_event.support_session, case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end),
    event_type,
    coalesce(category, 'system'),
    coalesce(outcome, 'success'),
    coalesce(source, 'app'),
    target_type,
    coalesce(metadata, '{}'),
    idempotency_key,
    coalesce(actor_kind, case
      when v_integration then 'integration'
      when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then 'service'
      when auth.jwt() -> 'act' ->> 'kind' = 'support' then 'support'
      when auth.jwt() -> 'act' ->> 'kind' = 'agent' then 'agent'
      when auth.jwt() -> 'act' is not null then 'impersonation'
      when auth.jwt() ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end),
    coalesce(actor_label, coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() ->> 'email')),
    (select o."name"::text from "better_supabase"."organizations" o where o."id" = tenant),
    target_label,
    summary,
    coalesce(summary_key, event_type),
    summary_params,
    coalesce(better_supabase.request_id_or_null(request_id), coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null(better_supabase.request_header('x-request-id')))),
    coalesce(better_supabase.request_id_or_null(correlation_id), coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null(better_supabase.request_header('x-correlation-id')))),
    coalesce(audit_event.scope, case when tenant is null then 'platform' else 'tenant' end)
  )
  returning "id" into entry_id;
  if audit_event.target_type is not null and audit_event.record_id is not null then
    perform pg_catalog.set_config('better_supabase.recorded', coalesce(pg_catalog.current_setting('better_supabase.recorded', true), '') || E'\n' || audit_event.target_type || ':' || audit_event.record_id, true);
  end if;
  return entry_id::text;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_event_trusted (
  event_type           text,
  category             text  DEFAULT NULL::text,
  outcome              text  DEFAULT 'success'::text,
  source               text  DEFAULT NULL::text,
  target_type          text  DEFAULT NULL::text,
  record_id            text  DEFAULT NULL::text,
  tenant               uuid  DEFAULT NULL::uuid,
  metadata             jsonb DEFAULT '{}'::jsonb,
  idempotency_key      text  DEFAULT NULL::text,
  restricted           jsonb DEFAULT NULL::jsonb,
  actor_id             uuid  DEFAULT NULL::uuid,
  summary              text  DEFAULT NULL::text,
  target_label         text  DEFAULT NULL::text,
  correlation_id       text  DEFAULT NULL::text,
  actor_kind           text  DEFAULT NULL::text,
  actor_label          text  DEFAULT NULL::text,
  ip                   inet  DEFAULT NULL::inet,
  user_agent           text  DEFAULT NULL::text,
  session_id           text  DEFAULT NULL::text,
  request_id           text  DEFAULT NULL::text,
  scope                text  DEFAULT NULL::text,
  support_session      uuid  DEFAULT NULL::uuid,
  impersonated_by      uuid  DEFAULT NULL::uuid,
  impersonation_reason text  DEFAULT NULL::text,
  summary_key          text  DEFAULT NULL::text,
  summary_params       jsonb DEFAULT NULL::jsonb
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  existing text;
  v_integration boolean := better_supabase.import_run() is not null;
  entry_id "better_supabase"."audit_events"."id"%type;
begin
  if restricted is not null or ip is not null or user_agent is not null or session_id is not null then
    raise exception 'audit_event got restricted details, and the audit module has no restricted table'
      using errcode = '22023', hint = 'Set blocks.audit.options.restricted to true.';
  end if;
  -- imports.audit 'summary' (ADR 0141): the run audits per entity at its end.
  if v_integration and current_setting('better_supabase.import_audit', true) = 'summary' then
    return null;
  end if;
  actor_id := coalesce(actor_id, auth.uid());
  if idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('better_supabase.audit_event'), pg_catalog.hashtext(coalesce(tenant::text, '') || ':' || idempotency_key));
    select l."id"::text into existing
    from "better_supabase"."audit_events" l
    where l."idempotency_key" = audit_event_trusted.idempotency_key
      and l."tenant_id" is not distinct from audit_event_trusted.tenant
    limit 1;
    if existing is not null then
      return existing;
    end if;
  end if;
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "metadata", "idempotency_key", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
  values (
    null,
    record_id,
    'event',
    actor_id,
    coalesce(auth.jwt() ->> 'role', current_user),
    tenant,
    coalesce(audit_event_trusted.impersonated_by, case when auth.jwt() -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'sub')::uuid end),
    coalesce(audit_event_trusted.impersonation_reason, auth.jwt() -> 'act' ->> 'reason'),
    coalesce(audit_event_trusted.support_session, case when auth.jwt() -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (auth.jwt() -> 'act' ->> 'session_id')::uuid end),
    event_type,
    coalesce(category, 'system'),
    coalesce(outcome, 'success'),
    coalesce(source, 'app'),
    target_type,
    coalesce(metadata, '{}'),
    idempotency_key,
    coalesce(actor_kind, case
      when v_integration then 'integration'
      when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then 'service'
      when auth.jwt() -> 'act' ->> 'kind' = 'support' then 'support'
      when auth.jwt() -> 'act' ->> 'kind' = 'agent' then 'agent'
      when auth.jwt() -> 'act' is not null then 'impersonation'
      when auth.jwt() ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end),
    coalesce(actor_label, coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() ->> 'email')),
    (select o."name"::text from "better_supabase"."organizations" o where o."id" = tenant),
    target_label,
    summary,
    coalesce(summary_key, event_type),
    summary_params,
    coalesce(better_supabase.request_id_or_null(request_id), coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null(better_supabase.request_header('x-request-id')))),
    coalesce(better_supabase.request_id_or_null(correlation_id), coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null(better_supabase.request_header('x-correlation-id')))),
    coalesce(audit_event_trusted.scope, case when tenant is null then 'platform' else 'tenant' end)
  )
  returning "id" into entry_id;
  if audit_event_trusted.target_type is not null and audit_event_trusted.record_id is not null then
    perform pg_catalog.set_config('better_supabase.recorded', coalesce(pg_catalog.current_setting('better_supabase.recorded', true), '') || E'\n' || audit_event_trusted.target_type || ':' || audit_event_trusted.record_id, true);
  end if;
  return entry_id::text;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_row_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  entry record;
  settings jsonb;
  entry_id "better_supabase"."audit_events"."id"%type;
  old_row jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_row jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  row_data jsonb := coalesce(new_row, old_row);
  changed_columns text[];
  changed_values jsonb;
  row_tenant uuid;
  v_jwt jsonb := auth.jwt();
  v_headers jsonb := better_supabase.request_headers();
  v_integration boolean := better_supabase.import_run() is not null;
  v_label text;
  path_value text;
  path_step jsonb;
begin
  -- An import run with imports.audit 'summary' audits one entry per entity at
  -- its end instead of one per row (ADR 0141).
  if v_integration and current_setting('better_supabase.import_audit', true) = 'summary' then
    return null;
  end if;
  if tg_nargs > 0 then
    settings := tg_argv[0]::jsonb;
    select array(select jsonb_array_elements_text(coalesce(settings -> 'ignore', '[]'))) as ignore,
      coalesce(
        nullif(array(select jsonb_array_elements_text(coalesce(settings -> 'key_columns', '[]'))), '{}'),
        (select array_agg(c.attname::text order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
         where i.indrelid = tg_relid and i.indisprimary),
        '{id}'
      ) as key_columns,
      array(select jsonb_array_elements_text(coalesce(settings -> 'redact', '[]'))) as redact,
      settings ->> 'category' as category, settings ->> 'event_prefix' as event_prefix,
      settings ->> 'target_type' as target_type, settings ->> 'tenant_column' as tenant_column,
      settings ->> 'label_column' as label_column,
      settings -> 'tenant_path' as tenant_path, settings ->> 'tenant_function' as tenant_function,
      settings ->> 'archive_column' as archive_column, settings ->> 'archive_value' as archive_value
    into entry;
  else
    select coalesce(a."ignore", '{}') as ignore, coalesce(a."key_columns", '{id}') as key_columns,
      coalesce(a."redact", '{}') as redact, a."category" as category,
      a."event_prefix" as event_prefix, a."target_type" as target_type,
      a."tenant_column" as tenant_column, a."label_column" as label_column,
      null::jsonb as tenant_path, null::text as tenant_function,
      null::text as archive_column, null::text as archive_value
    into entry
    from (select 1) one
    left join "better_supabase"."audited_tables" a on a."target" = tg_relid::regclass;
  end if;
  if position(E'\n' || coalesce(entry.target_type, tg_table_name) || ':' || coalesce((select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)), '') || E'\n' in coalesce(current_setting('better_supabase.recorded', true), '') || E'\n') > 0 then
    return null;
  end if;
  row_tenant := case when row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end;
  -- A child row without a tenant column: follow the foreign-key path
  -- registered through tenant_path, then the tenant function.
  if row_tenant is null and entry.tenant_path is not null then
    path_value := row_data ->> (entry.tenant_path ->> 'column');
    for path_step in select * from jsonb_array_elements(entry.tenant_path -> 'steps') loop
      exit when path_value is null;
      execute format('select %I::text from %s where %I::text = $1 limit 1',
        path_step ->> 'read', path_step ->> 'table', path_step ->> 'ref')
        into path_value using path_value;
    end loop;
    row_tenant := case when path_value ~* '^[0-9a-f-]{36}$' then (path_value)::uuid end;
  end if;
  if row_tenant is null and entry.tenant_function is not null then
    execute format('select %s($1)::text', (entry.tenant_function::regprocedure)::oid::regproc) into path_value using row_data;
    row_tenant := case when path_value ~* '^[0-9a-f-]{36}$' then (path_value)::uuid end;
  end if;
  if row_tenant is not null then
    v_label := better_supabase.memo_slot_get('audit.tenant_label.t' || replace(row_tenant::text, '-', ''));
    if v_label is null then
      v_label := (select o."name"::text from "better_supabase"."organizations" o where o."id" = row_tenant);
      perform better_supabase.memo_slot_set('audit.tenant_label.t' || replace(row_tenant::text, '-', ''), coalesce(v_label, ''));
    end if;
  end if;
  old_row := old_row - entry.ignore;
  new_row := new_row - entry.ignore;
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into changed_columns
    from jsonb_each(new_row) n
    where n.value is distinct from old_row -> n.key;
    if changed_columns is null then
      return null;
    end if;
  end if;
  -- Redacted columns stay in changed, with their values masked.
  old_row := old_row || coalesce((select jsonb_object_agg(k, '"[redacted]"'::jsonb) from unnest(entry.redact) k where old_row ? k), '{}');
  new_row := new_row || coalesce((select jsonb_object_agg(k, '"[redacted]"'::jsonb) from unnest(entry.redact) k where new_row ? k), '{}');
  insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
  values (
    tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    lower(tg_op),
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case tg_op when 'INSERT' then 'created' when 'UPDATE' then case when entry.archive_column is null then 'updated' when (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'archived' when (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'restored' else 'updated' end else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when v_integration then 'integration'
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' ->> 'kind' = 'agent' then 'agent'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    v_label,
    row_data ->> entry.label_column,
    null,
    null,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
  )
  returning "id" into entry_id;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.audit_statement_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  entry record;
  settings jsonb;
  v_jwt jsonb := auth.jwt();
  v_headers jsonb := better_supabase.request_headers();
  v_integration boolean := better_supabase.import_run() is not null;
begin
  if v_integration and current_setting('better_supabase.import_audit', true) = 'summary' then
    return null;
  end if;
  if tg_nargs > 0 then
    settings := tg_argv[0]::jsonb;
    select array(select jsonb_array_elements_text(coalesce(settings -> 'ignore', '[]'))) as ignore,
      coalesce(
        nullif(array(select jsonb_array_elements_text(coalesce(settings -> 'key_columns', '[]'))), '{}'),
        (select array_agg(c.attname::text order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_catalog.pg_attribute c on c.attrelid = i.indrelid and c.attnum = k.attnum
         where i.indrelid = tg_relid and i.indisprimary),
        '{id}'
      ) as key_columns,
      array(select jsonb_array_elements_text(coalesce(settings -> 'redact', '[]'))) as redact,
      settings ->> 'category' as category, settings ->> 'event_prefix' as event_prefix,
      settings ->> 'target_type' as target_type, settings ->> 'tenant_column' as tenant_column,
      settings ->> 'label_column' as label_column,
      settings -> 'tenant_path' as tenant_path, settings ->> 'tenant_function' as tenant_function,
      settings ->> 'archive_column' as archive_column, settings ->> 'archive_value' as archive_value
    into entry;
  else
    select coalesce(a."ignore", '{}') as ignore, coalesce(a."key_columns", '{id}') as key_columns,
      coalesce(a."redact", '{}') as redact, a."category" as category,
      a."event_prefix" as event_prefix, a."target_type" as target_type,
      a."tenant_column" as tenant_column, a."label_column" as label_column,
      null::jsonb as tenant_path, null::text as tenant_function,
      null::text as archive_column, null::text as archive_value
    into entry
    from (select 1) one
    left join "better_supabase"."audited_tables" a on a."target" = tg_relid::regclass;
  end if;
  if tg_op = 'INSERT' then
    with src as (
      select null::jsonb as old_row, to_jsonb(n) as new_row from new_rows n
    ), paired as (
      select case when s.old_row is null then 'insert' when s.new_row is null then 'delete' else 'update' end as op,
        coalesce(s.new_row, s.old_row) as row_data,
        s.old_row - entry.ignore as old_row, s.new_row - entry.ignore as new_row
      from src s
    ), changed as (
      select p.*, case when p.op = 'update' then (
          select array_agg(e.key order by e.key) from jsonb_each(p.new_row) e
          where e.value is distinct from p.old_row -> e.key
        ) end as changed_columns
      from paired p
    ), kept as (
      select c.*, case when c.row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (c.row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end as row_tenant
      from changed c
      where (c.op <> 'update' or c.changed_columns is not null)
        and not (position(E'\n' || coalesce(entry.target_type, tg_table_name) || ':' || coalesce((select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)), '') || E'\n' in coalesce(current_setting('better_supabase.recorded', true), '') || E'\n') > 0)
    ), final as (
      select k.op, k.row_data, k.changed_columns, k.row_tenant,
        k.old_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.old_row ? r), '{}') as old_row,
        k.new_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.new_row ? r), '{}') as new_row
      from kept k
    ), labels as (
      select t.row_tenant as tenant_key, (select o."name"::text from "better_supabase"."organizations" o where o."id" = t.row_tenant) as label
      from (select distinct row_tenant from kept) t
    )
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
    select tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    op,
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then case when entry.archive_column is null then 'updated' when (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'archived' when (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'restored' else 'updated' end else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when v_integration then 'integration'
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' ->> 'kind' = 'agent' then 'agent'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    l.label,
    row_data ->> entry.label_column,
    null,
    null,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
    from final
    left join labels l on l.tenant_key is not distinct from final.row_tenant;
  elsif tg_op = 'DELETE' then
    with src as (
      select to_jsonb(o) as old_row, null::jsonb as new_row from old_rows o
    ), paired as (
      select case when s.old_row is null then 'insert' when s.new_row is null then 'delete' else 'update' end as op,
        coalesce(s.new_row, s.old_row) as row_data,
        s.old_row - entry.ignore as old_row, s.new_row - entry.ignore as new_row
      from src s
    ), changed as (
      select p.*, case when p.op = 'update' then (
          select array_agg(e.key order by e.key) from jsonb_each(p.new_row) e
          where e.value is distinct from p.old_row -> e.key
        ) end as changed_columns
      from paired p
    ), kept as (
      select c.*, case when c.row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (c.row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end as row_tenant
      from changed c
      where (c.op <> 'update' or c.changed_columns is not null)
        and not (position(E'\n' || coalesce(entry.target_type, tg_table_name) || ':' || coalesce((select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)), '') || E'\n' in coalesce(current_setting('better_supabase.recorded', true), '') || E'\n') > 0)
    ), final as (
      select k.op, k.row_data, k.changed_columns, k.row_tenant,
        k.old_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.old_row ? r), '{}') as old_row,
        k.new_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.new_row ? r), '{}') as new_row
      from kept k
    ), labels as (
      select t.row_tenant as tenant_key, (select o."name"::text from "better_supabase"."organizations" o where o."id" = t.row_tenant) as label
      from (select distinct row_tenant from kept) t
    )
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
    select tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    op,
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then case when entry.archive_column is null then 'updated' when (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'archived' when (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'restored' else 'updated' end else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when v_integration then 'integration'
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' ->> 'kind' = 'agent' then 'agent'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    l.label,
    row_data ->> entry.label_column,
    null,
    null,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
    from final
    left join labels l on l.tenant_key is not distinct from final.row_tenant;
  else
    with src as (
      select o.j as old_row, n.j as new_row
      from (select to_jsonb(r) as j, (select string_agg(to_jsonb(r) ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)) as k from old_rows r) o
      full join (select to_jsonb(r) as j, (select string_agg(to_jsonb(r) ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)) as k from new_rows r) n on o.k = n.k
    ), paired as (
      select case when s.old_row is null then 'insert' when s.new_row is null then 'delete' else 'update' end as op,
        coalesce(s.new_row, s.old_row) as row_data,
        s.old_row - entry.ignore as old_row, s.new_row - entry.ignore as new_row
      from src s
    ), changed as (
      select p.*, case when p.op = 'update' then (
          select array_agg(e.key order by e.key) from jsonb_each(p.new_row) e
          where e.value is distinct from p.old_row -> e.key
        ) end as changed_columns
      from paired p
    ), kept as (
      select c.*, case when c.row_data ->> coalesce(entry.tenant_column, 'organization_id') ~* '^[0-9a-f-]{36}$' then (c.row_data ->> coalesce(entry.tenant_column, 'organization_id'))::uuid end as row_tenant
      from changed c
      where (c.op <> 'update' or c.changed_columns is not null)
        and not (position(E'\n' || coalesce(entry.target_type, tg_table_name) || ':' || coalesce((select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)), '') || E'\n' in coalesce(current_setting('better_supabase.recorded', true), '') || E'\n') > 0)
    ), final as (
      select k.op, k.row_data, k.changed_columns, k.row_tenant,
        k.old_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.old_row ? r), '{}') as old_row,
        k.new_row || coalesce((select jsonb_object_agg(r, '"[redacted]"'::jsonb) from unnest(entry.redact) r where k.new_row ? r), '{}') as new_row
      from kept k
    ), labels as (
      select t.row_tenant as tenant_key, (select o."name"::text from "better_supabase"."organizations" o where o."id" = t.row_tenant) as label
      from (select distinct row_tenant from kept) t
    )
    insert into "better_supabase"."audit_events" ("table_name", "record_id", "op", "old_record", "new_record", "changed", "actor_id", "actor_role", "tenant_id", "impersonated_by", "impersonation_reason", "support_session_id", "event_type", "category", "outcome", "source", "target_type", "actor_kind", "actor_label", "tenant_label", "target_label", "summary", "summary_key", "summary_params", "request_id", "correlation_id", "scope")
    select tg_table_schema || '.' || tg_table_name,
    (select string_agg(row_data ->> k.name, ',' order by k.ord) from unnest(entry.key_columns) with ordinality k(name, ord)),
    op,
    old_row,
    new_row,
    changed_columns,
    coalesce(auth.uid(), better_supabase.acting_member()),
    coalesce(v_jwt ->> 'role', current_user),
    row_tenant,
    case when v_jwt -> 'act' ->> 'sub' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'sub')::uuid end,
    v_jwt -> 'act' ->> 'reason',
    case when v_jwt -> 'act' ->> 'session_id' ~ '^[0-9a-f-]{36}$' then (v_jwt -> 'act' ->> 'session_id')::uuid end,
    coalesce(entry.event_prefix, tg_table_name) || '.' || case op when 'insert' then 'created' when 'update' then case when entry.archive_column is null then 'updated' when (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'archived' when (case when entry.archive_value is null then coalesce(old_row ->> entry.archive_column, 'false') <> 'false' else old_row ->> entry.archive_column is not distinct from entry.archive_value end) and not (case when entry.archive_value is null then coalesce(new_row ->> entry.archive_column, 'false') <> 'false' else new_row ->> entry.archive_column is not distinct from entry.archive_value end) then 'restored' else 'updated' end else 'deleted' end,
    coalesce(entry.category, 'data'),
    'success',
    'database',
    coalesce(entry.target_type, tg_table_name),
    case
      when v_integration then 'integration'
      when coalesce(v_jwt ->> 'role', '') = 'service_role' then 'service'
      when v_jwt -> 'act' ->> 'kind' = 'support' then 'support'
      when v_jwt -> 'act' ->> 'kind' = 'agent' then 'agent'
      when v_jwt -> 'act' is not null then 'impersonation'
      when v_jwt ->> 'client_id' is not null then 'oauth-client'
      when auth.uid() is not null then 'user'
      else 'system'
    end,
    coalesce(v_jwt -> 'user_metadata' ->> 'full_name', v_jwt ->> 'email'),
    l.label,
    row_data ->> entry.label_column,
    null,
    null,
    null,
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.request_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-request-id'))),
    coalesce(better_supabase.request_id_or_null(current_setting('better_supabase.correlation_id', true)), better_supabase.request_id_or_null((v_headers ->> 'x-correlation-id'))),
    case when row_tenant is null then 'platform' else 'tenant' end
    from final
    left join labels l on l.tenant_key is not distinct from final.row_tenant;
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.caller_authz_version()
  RETURNS bigint
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if auth.uid() is null then
    return null;
  end if;
  return permdock.authz_version_for(auth.uid());
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.cancel_approval (
  request_id uuid,
  reason     text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = cancel_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_req."requested_by" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_req."tenant_id", 'approvals.manage'), false)) then
    raise exception 'only the requester or a manager can cancel this request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  update "better_supabase"."approval_requests" r set "status" = 'cancelled', "decided_at" = now()
    where r."id" = v_req."id" returning * into v_req;
  perform better_supabase.audit_event(
    event_type => 'approval.cancelled',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'cancelled' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id" || coalesce(': ' || left(nullif(btrim(cancel_approval.reason), ''), 500), ''),
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.check_sso_provider (
  tenant  uuid,
  domains text[],
  actor   uuid   DEFAULT NULL::uuid
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role registers SSO providers' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if not (check_sso_provider.actor is null or coalesce(better_supabase.can_user(check_sso_provider.actor, 'tenant', check_sso_provider.tenant, 'sso.manage'), false)) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if cardinality(check_sso_provider.domains) = 0 or exists (
    select 1 from unnest(check_sso_provider.domains) as w(domain)
    where not exists (
      select 1 from "better_supabase"."sso_domains" x where x."tenant_id" = check_sso_provider.tenant and x."domain" = lower(w.domain) and x."verified_at" is not null
    )
  ) then
    raise exception 'Every SSO domain must be a verified domain of the organization' using errcode = '22023', hint = 'SSO_DOMAIN_NOT_VERIFIED';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.close_support_request (
  request_id uuid
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  update "better_supabase"."support_requests" x set "expires_at" = least(x."expires_at", now())
  where x."id" = $1 and x."approved_by" is null and x."session_id" is null;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.consume_approval (
  request_id  uuid,
  fingerprint text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = consume_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_req."requested_by" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_req."tenant_id", 'approvals.manage'), false)) then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."consumed_at" is not null then
    raise exception 'this approval was already used' using errcode = '22023', hint = 'APPROVAL_CONSUMED';
  end if;
  if v_req."status" <> 'approved' then
    raise exception 'this request is not approved' using errcode = '22023', hint = 'APPROVAL_NOT_APPROVED';
  end if;
  if v_req."fingerprint" is distinct from consume_approval.fingerprint then
    raise exception 'the request changed after it was approved; ask for approval again' using errcode = '22023', hint = 'APPROVAL_FINGERPRINT_MISMATCH';
  end if;
  update "better_supabase"."approval_requests" r set "status" = 'consumed', "consumed_at" = now()
    where r."id" = v_req."id" returning * into v_req;
  perform better_supabase.audit_event(
    event_type => 'approval.consumed',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'consumed' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.consume_quota (
  tenant          uuid,
  meter           text,
  quantity        numeric DEFAULT 1,
  idempotency_key text    DEFAULT NULL::text,
  source          text    DEFAULT NULL::text,
  metadata        jsonb   DEFAULT NULL::jsonb,
  actor           uuid    DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  quota record;
  used numeric;
  win record;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.record'), false)) then
    raise exception 'Not allowed to record usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  perform pg_advisory_xact_lock(hashtext('better_supabase.consume_quota'), hashtext(tenant::text || '/' || meter));
  if idempotency_key is not null and exists (
    select 1 from "better_supabase"."usage_events" e
    where e."tenant_id" = consume_quota.tenant and e."meter" = consume_quota.meter and e."idempotency_key" = consume_quota.idempotency_key
  ) then
    return jsonb_build_object('recorded', false, 'used', "better_supabase"."usage_used"(tenant, meter, coalesce((select q.period from "better_supabase"."usage_quota"(tenant, meter) q), 'month')), 'today', "better_supabase"."usage_used"(tenant, meter, 'day'));
  end if;
  select * into quota from "better_supabase"."usage_quota"(tenant, meter);
  if quota.quota_limit is not null then
    used := "better_supabase"."usage_used"(tenant, meter, quota.period);
    if used + quantity > quota.quota_limit then
      select * into win from "better_supabase"."usage_window"(tenant, quota.period);
      raise exception 'Quota for % exceeded', meter using
        errcode = 'BSQ29',
        hint = 'QUOTA_EXCEEDED',
        detail = jsonb_build_object(
          'meter', meter,
          'limit', quota.quota_limit,
          'used', used,
          'retry_after', greatest(1, ceil(extract(epoch from win.ends_at - now()))::integer)
        )::text;
    end if;
  end if;
  return "better_supabase"."record_usage"(tenant, meter, quantity, idempotency_key, source, metadata, actor);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.converted_into (
  tenant      uuid,
  origin_type text,
  origin_id   text,
  into_type   text
)
  RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select r."source_id"
  from "better_supabase"."relations" r
  where r."tenant_id" = converted_into.tenant
    and r."kind" = (select k.canonical from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = 'created_from')
    and r."target_type" = converted_into.origin_type and r."target_id" = converted_into.origin_id
    and r."source_type" = converted_into.into_type
  order by r."created_at", r."id"
  limit 1
$function$;

CREATE OR REPLACE FUNCTION better_supabase.create_api_key (
  name        text,
  public_id   text,
  secret_hash text,
  tenant      uuid                     DEFAULT NULL::uuid,
  personal    boolean                  DEFAULT false,
  scopes      text[]                   DEFAULT '{}'::text[],
  expires_at  timestamp with time zone DEFAULT NULL::timestamp WITH time zone,
  rate_limit  integer                  DEFAULT NULL::integer,
  prefix      text                     DEFAULT 'bs'::text,
  kind        text                     DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  owner uuid := case when personal then auth.uid() end;
  created "better_supabase"."api_keys";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if personal and owner is null then
    raise exception 'Sign in to create a personal API key' using errcode = '42501', hint = 'API_KEY_SIGN_IN';
  end if;
  if not personal and tenant is null then
    raise exception 'A tenant API key needs a tenant' using errcode = '22023', hint = 'API_KEY_TENANT_REQUIRED';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    if not personal and not coalesce(better_supabase.can('tenant', tenant, 'api_keys.manage'), false) then
      raise exception 'Not allowed to manage API keys in this tenant' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
    end if;
    if personal and tenant is not null and not coalesce(better_supabase.can('tenant', tenant, 'api_keys.own'), false) then
      raise exception 'Not allowed to create API keys in this tenant' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
    end if;
    if personal and tenant is null and exists (
      select 1 from better_supabase.member_organization_ids() as m(id)
      where m.id not in (select better_supabase.tenant_ids_with('api_keys.own'))
    ) then
      raise exception 'Not allowed to create API keys for every tenant' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
    end if;
  end if;
  if exists (select 1 from unnest(coalesce(scopes, '{}')) s where s = any ('{impersonation.start,organization.delete,organization.transfer_ownership,platform.invite,sso.manage}'::text[])) then
    raise exception 'Only a signed-in user may use this permission, so an API key cannot carry it' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
  end if;
  if (auth.jwt() -> 'api_key' is not null
      or coalesce(auth.jwt() ->> 'client_id', '') <> ''
      or auth.jwt() -> 'act' is not null) and exists (
    select 1 from unnest(coalesce(scopes, '{}')) s
    where not case
      when auth.jwt() -> 'api_key' is not null then
        coalesce(auth.jwt() -> 'api_key' -> 'scopes', '[]'::jsonb) ?| array['*', s]
      else exists (
        select 1
        from unnest(case jsonb_typeof(auth.jwt() -> 'scope')
            when 'string' then regexp_split_to_array(btrim(auth.jwt() ->> 'scope'), '\s+')
            when 'array' then array(select jsonb_array_elements_text(auth.jwt() -> 'scope'))
            else '{}'::text[]
          end) t(scope)
        where t.scope <> ''
          and (t.scope = s or exists (
            select 1 from unnest(better_supabase.scope_permissions(t.scope)) k(key)
            where better_supabase.permission_matches(k.key, s)
          ))
      )
    end
  ) then
    raise exception 'A token may only give a key the scopes it holds itself' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
  end if;
  if '*' = any (coalesce(scopes, '{}')) then
    raise exception 'The authorization provider checks scopes as exact permission keys, so a key cannot carry *' using errcode = '22023', hint = 'API_KEY_SCOPE_WILDCARD';
  end if;
  if expires_at is not null and expires_at <= now() then
    raise exception 'expires_at is in the past' using errcode = '22023', hint = 'API_KEY_EXPIRED';
  end if;
  insert into "better_supabase"."api_keys" ("tenant_id", "user_id", "name", "prefix", "public_id", "secret_hash", "scopes", "kind", "rate_limit", "expires_at")
  values (tenant, owner, create_api_key.name, create_api_key.prefix, create_api_key.public_id, create_api_key.secret_hash, coalesce(create_api_key.scopes, '{}'), create_api_key.kind, create_api_key.rate_limit, create_api_key.expires_at)
  returning * into created;
  perform better_supabase.audit_event(
    event_type => 'api_key.created',
    category => 'security',
    target_type => 'api_key',
    record_id => created."id"::text,
    target_label => created."name",
    tenant => (created."tenant_id")::uuid,
    metadata => jsonb_build_object('keyId', created."id", 'organizationId', created."tenant_id"::text, 'userId', created."user_id", 'name', created."name", 'publicId', created."public_id")
  );
  return jsonb_build_object(
    'id', created."id",
    'organization_id', created."tenant_id",
    'user_id', created."user_id",
    'name', created."name",
    'prefix', created."prefix",
    'public_id', created."public_id",
    'scopes', to_jsonb(created."scopes"),
    'kind', created."kind",
    'rate_limit', created."rate_limit",
    'expires_at', created."expires_at",
    'last_used_at', created."last_used_at",
    'revoked_at', created."revoked_at",
    'rotated_from', created."rotated_from",
    'created_by', created."created_by",
    'created_at', created."created_at",
    'state', case
      when created."revoked_at" is not null and created."revoked_at" <= now() then 'revoked'
      when created."expires_at" is not null and created."expires_at" <= now() then 'expired'
      when created."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = created."id" order by s."created_at" desc limit 1)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.create_invitation (
  organization  uuid,
  invitee_email text,
  invitee_role  text     DEFAULT 'member'::text,
  valid_for     interval DEFAULT '7 days'::interval
)
  RETURNS text
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select "better_supabase"."invite_member"($1, $2, $3, $4) ->> 'token'
$function$;

CREATE OR REPLACE FUNCTION better_supabase.create_organization (
  attrs jsonb
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  owner uuid := case when service then nullif(attrs ->> 'owner_id', '')::uuid else auth.uid() end;
  organization uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if owner is null then
    raise exception 'An organization needs an owner' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if better_supabase.user_disabled(owner) then
    raise exception 'The user is disabled' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  case "better_supabase"."organization_slug_problem"(coalesce(attrs ->> 'slug', ''), null)
    when 'invalid' then raise exception 'Invalid slug "%"', attrs ->> 'slug' using errcode = '23514', hint = 'ORGANIZATION_SLUG_INVALID';
    when 'reserved' then raise exception 'The slug "%" is reserved', attrs ->> 'slug' using errcode = '23514', hint = 'ORGANIZATION_SLUG_RESERVED';
    when 'taken' then raise exception 'The slug "%" is taken', attrs ->> 'slug' using errcode = '23505', hint = 'ORGANIZATION_SLUG_TAKEN';
    else null;
  end case;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_organization_create"(jsonb, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::jsonb, $2::uuid)', v_hook::oid::regproc)
        using attrs, owner;
    end if;
  end;
  insert into "better_supabase"."organizations" ("name", "slug", "created_by")
  select r."name", r."slug", owner
  from jsonb_populate_record(null::"better_supabase"."organizations", attrs) r
  returning "id" into organization;
  insert into "public"."organization_memberships" ("organization_id", "user_id", "role")
  values (organization, owner, 'owner');
  perform "better_supabase"."seed_tenant_defaults"(organization);
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_organization_create"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using organization, owner;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.created',
    category => 'configuration',
    target_type => 'organization',
    record_id => organization::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', owner, 'role', 'owner')
  );
  return organization;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.create_ssf_stream (
  id               uuid,
  receiver         text,
  tenant           text,
  audience         text[],
  delivery_method  text,
  events_requested text[],
  events_delivered text[],
  description      text   DEFAULT NULL::text,
  endpoint_url     text   DEFAULT NULL::text,
  credential_ref   jsonb  DEFAULT NULL::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."ssf_streams";
  v_endpoint uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  insert into "better_supabase"."ssf_streams" ("id", "tenant", "receiver", "audience", "delivery_method", "events_requested", "events_delivered", "description")
  values (create_ssf_stream.id, create_ssf_stream.tenant, create_ssf_stream.receiver, create_ssf_stream.audience,
    create_ssf_stream.delivery_method, coalesce(create_ssf_stream.events_requested, '{}'),
    coalesce(create_ssf_stream.events_delivered, '{}'), create_ssf_stream.description)
  returning * into v_row;
  if v_row."delivery_method" = 'urn:ietf:rfc:8935' then
    raise exception 'push delivery needs the webhooks module' using errcode = '0A000', hint = 'SECURITY_EVENT_PUSH_UNAVAILABLE';
  end if;
  perform better_supabase.audit_event(
    event_type => 'ssf_stream.created',
    category => 'security',
    target_type => 'ssf_stream',
    record_id => v_row."id"::text,
    metadata => jsonb_build_object('streamId', v_row."id", 'receiver', v_row."receiver", 'tenant', v_row."tenant", 'method', v_row."delivery_method")
  );
  return jsonb_build_object(
    'id', v_row."id",
    'tenant', v_row."tenant",
    'receiver', v_row."receiver",
    'audience', to_jsonb(v_row."audience"),
    'description', v_row."description",
    'eventsRequested', to_jsonb(v_row."events_requested"),
    'eventsDelivered', to_jsonb(v_row."events_delivered"),
    'method', v_row."delivery_method",
    'endpointUrl', null::text,
    'status', v_row."status",
    'reason', v_row."reason",
    'createdAt', v_row."created_at",
    'updatedAt', v_row."updated_at"
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.create_team (
  tenant      uuid,
  name        text,
  description text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_id uuid;
  v_slug text := trim(both '-' from regexp_replace(lower(create_team.name), '[^a-z0-9]+', '-', 'g'));
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', create_team.tenant, 'teams.manage'), false)) then
    raise exception 'not allowed to manage teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  if v_slug is null or v_slug = '' then
    raise exception 'team name needs a slug' using errcode = '22023', hint = 'TEAM_SLUG_INVALID';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_team_create"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using create_team.tenant, v_slug;
    end if;
  end;
  insert into "better_supabase"."teams" ("tenant_id", "name", "slug", "description", "created_by")
  values (create_team.tenant, create_team.name, v_slug, create_team.description, auth.uid())
  returning "id" into v_id;
  perform better_supabase.audit_event(
    event_type => 'team.created',
    category => 'membership',
    target_type => 'team',
    record_id => (v_id)::text,
    tenant => (create_team.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', create_team.tenant, 'id', v_id, 'name', create_team.name)
  );
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_team_create"(uuid, uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid)', v_hook::oid::regproc)
        using v_id, create_team.tenant;
    end if;
  end;
  return jsonb_build_object('id', v_id, 'slug', v_slug);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.decide_approval (
  request_id uuid,
  decision   text,
  comment    text DEFAULT NULL::text,
  decided_by uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_count integer;
  v_service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  v_actor uuid := coalesce(decide_approval.decided_by, auth.uid());
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if decide_approval.decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023', hint = 'APPROVAL_DECISION_INVALID';
  end if;
  if decide_approval.decided_by is not null and not v_service and decide_approval.decided_by is distinct from auth.uid() then
    raise exception 'only the service role decides for another user' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = decide_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  if v_req."expires_at" is not null and v_req."expires_at" <= now() then
    raise exception 'this request has expired' using errcode = '22023', hint = 'APPROVAL_EXPIRED';
  end if;
  if exists (select 1 from "better_supabase"."approval_items" x where x."request_id" = v_req."id") then
    raise exception 'this request has items; use decide_approval_items' using errcode = '22023', hint = 'APPROVAL_ITEMS_REQUIRED';
  end if;
  if v_service then
    if v_actor is not null and v_actor = v_req."requested_by" and coalesce(v_req."policy" ->> 'mode', 'authorize') <> 'confirm'
      and not coalesce((v_req."policy" ->> 'selfApproval')::boolean, false) then
      raise exception 'the requester can''t decide their own request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
    end if;
    if v_actor is not null and coalesce(v_req."policy" -> 'excludedUserIds', '[]'::jsonb) ? v_actor::text then
      raise exception 'this user is left out of deciding this request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
    end if;
    if v_actor is not null and exists (
      select 1 from "better_supabase"."approval_decisions" x
      where x."request_id" = v_req."id" and x."step" = v_req."step" and x."approver" = v_actor
    ) then
      raise exception 'this user already decided this step' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
    end if;
  elsif not "better_supabase"."approval_eligible"(v_req."id") then
    raise exception 'not an approver for this step' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", decide_approval.decision;
    end if;
  end;
  insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision", "comment")
  values (v_req."id", v_req."tenant_id", v_req."step", v_actor, decide_approval.decision, decide_approval.comment);
  if decide_approval.decision = 'rejected' then
    update "better_supabase"."approval_requests" r set "status" = 'rejected', "decided_at" = now()
      where r."id" = v_req."id" returning * into v_req;
    perform better_supabase.audit_event(
    event_type => 'approval.rejected',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'rejected' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
    perform "better_supabase"."approval_notify"(v_req."id", 'rejected');
    if v_req."subject_type" = 'support_request' then
      perform "better_supabase"."close_support_request"(v_req."subject_id"::uuid);
    end if;
  else
    select count(*) into v_count from "better_supabase"."approval_decisions" x
      where x."request_id" = v_req."id" and x."step" = v_req."step" and x."decision" = 'approved';
    if v_req."policy" ->> 'mode' = 'confirm' and v_req."requested_by" = v_actor then
      update "better_supabase"."approval_requests" r set "status" = 'approved', "decided_at" = now()
        where r."id" = v_req."id" returning * into v_req;
      perform "better_supabase"."approval_finalize"(v_req."id");
    elsif (case when coalesce((v_req."policy" -> 'steps' -> v_req."step" ->> 'all')::boolean, false)
        and not coalesce((v_req."policy" -> 'steps' -> v_req."step" ->> 'escalated')::boolean, false)
      then jsonb_array_length(coalesce(v_req."policy" -> 'steps' -> v_req."step" -> 'approvers' -> 'users', '[]'::jsonb)) > 0
        and not exists (
          select 1 from jsonb_array_elements_text(v_req."policy" -> 'steps' -> v_req."step" -> 'approvers' -> 'users') u(id)
          where not exists (
            select 1 from "better_supabase"."approval_decisions" x
            where x."request_id" = v_req."id" and x."step" = v_req."step" and x."decision" = 'approved'
              and (x."approver" = u.id::uuid or exists (
                select 1 from "better_supabase"."approval_decisions" y
                where y."request_id" = x."request_id" and y."step" = x."step" and y."decision" = 'delegated'
                  and y."approver" = u.id::uuid and y."delegate_to" = x."approver"
              ))
          )
        )
      else v_count >= coalesce((v_req."policy" -> 'steps' -> v_req."step" ->> 'required')::integer, 1) end) then
      if v_req."step" + 1 >= jsonb_array_length(v_req."policy" -> 'steps') then
        update "better_supabase"."approval_requests" r set "status" = 'approved', "decided_at" = now()
          where r."id" = v_req."id" returning * into v_req;
        perform "better_supabase"."approval_finalize"(v_req."id");
      else
        update "better_supabase"."approval_requests" r set "step" = r."step" + 1, "reminded_at" = null
          where r."id" = v_req."id" returning * into v_req;
        perform "better_supabase"."approval_notify"(v_req."id", 'requested');
      end if;
    end if;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_req."status";
    end if;
  end;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.decide_approval_items (
  request_id uuid,
  decisions  jsonb,
  decided_by uuid  DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_item "better_supabase"."approval_items"%rowtype;
  v_each jsonb;
  v_decision text;
  v_service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  v_actor uuid := coalesce(decide_approval_items.decided_by, auth.uid());
  v_pending integer;
  v_approved integer;
  v_outcome text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if jsonb_typeof(decide_approval_items.decisions) is distinct from 'array' or jsonb_array_length(decide_approval_items.decisions) = 0 then
    raise exception 'decisions must be a non-empty array' using errcode = '22023', hint = 'APPROVAL_DECISION_INVALID';
  end if;
  if decide_approval_items.decided_by is not null and not v_service and decide_approval_items.decided_by is distinct from auth.uid() then
    raise exception 'only the service role decides for another user' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = decide_approval_items.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  if v_req."expires_at" is not null and v_req."expires_at" <= now() then
    raise exception 'this request has expired' using errcode = '22023', hint = 'APPROVAL_EXPIRED';
  end if;
  if not exists (select 1 from "better_supabase"."approval_items" x where x."request_id" = v_req."id") then
    raise exception 'this request has no items; use decide_approval' using errcode = '22023', hint = 'APPROVAL_ITEMS_NONE';
  end if;
  if v_actor is not null and v_actor = v_req."requested_by" and coalesce(v_req."policy" ->> 'mode', 'authorize') <> 'confirm'
    and not coalesce((v_req."policy" ->> 'selfApproval')::boolean, false) then
    raise exception 'the requester can''t decide their own request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if v_actor is not null and coalesce(v_req."policy" -> 'excludedUserIds', '[]'::jsonb) ? v_actor::text then
    raise exception 'this user is left out of deciding this request' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  for v_each in select e.value from jsonb_array_elements(decide_approval_items.decisions) e loop
    v_decision := v_each ->> 'decision';
    if v_decision is null or v_decision not in ('approved', 'rejected') or jsonb_typeof(v_each -> 'key') is distinct from 'string' then
      raise exception 'each decision needs a key and a decision of approved or rejected' using errcode = '22023', hint = 'APPROVAL_DECISION_INVALID';
    end if;
    select * into v_item from "better_supabase"."approval_items" x
    where x."request_id" = v_req."id" and x."key" = v_each ->> 'key' for update;
    if not found then
      raise exception 'this request has no such item' using errcode = 'P0002', hint = 'APPROVAL_ITEM_NOT_FOUND';
    end if;
    if v_item."status" <> 'pending' then
      raise exception 'this item is no longer pending' using errcode = '22023', hint = 'APPROVAL_ITEM_CLOSED';
    end if;
    if not v_service then
      if v_item."permission" is not null then
        if not (coalesce(better_supabase.can('tenant', v_req."tenant_id", v_item."permission"), false)) then
          raise exception 'not an approver for this item' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
        end if;
      elsif not "better_supabase"."approval_eligible"(v_req."id") then
        raise exception 'not an approver for this item' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
      end if;
    end if;
    if v_decision = 'approved' and exists (
      select 1 from "better_supabase"."approval_items" dep
      where dep."request_id" = v_req."id" and dep."key" = any(v_item."depends_on") and dep."status" <> 'approved'
    ) then
      raise exception 'an item this one depends on is not approved' using errcode = '22023', hint = 'APPROVAL_ITEM_BLOCKED';
    end if;
    declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_decision;
    end if;
  end;
    update "better_supabase"."approval_items" x set "status" = v_decision, "decided_by" = v_actor, "decided_at" = now()
    where x."id" = v_item."id";
    if v_decision = 'rejected' then
      with recursive blocked(key) as (
        select y."key" from "better_supabase"."approval_items" y
        where y."request_id" = v_req."id" and v_item."key" = any(y."depends_on")
        union
        select y."key" from "better_supabase"."approval_items" y join blocked b on b.key = any(y."depends_on")
        where y."request_id" = v_req."id"
      )
      update "better_supabase"."approval_items" x set "status" = 'rejected', "decided_by" = v_actor, "decided_at" = now()
      where x."request_id" = v_req."id" and x."status" = 'pending' and x."key" in (select key from blocked);
    end if;
  end loop;
  select count(*) filter (where x."status" = 'pending'), count(*) filter (where x."status" = 'approved')
    into v_pending, v_approved
  from "better_supabase"."approval_items" x where x."request_id" = v_req."id";
  if v_pending = 0 then
    v_outcome := case when v_approved > 0 then 'approved' else 'rejected' end;
    insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision")
    values (v_req."id", v_req."tenant_id", v_req."step", v_actor, v_outcome)
    on conflict do nothing;
    update "better_supabase"."approval_requests" r set "status" = v_outcome, "decided_at" = now()
      where r."id" = v_req."id" returning * into v_req;
    if v_outcome = 'approved' then
      perform "better_supabase"."approval_finalize"(v_req."id");
    else
      perform better_supabase.audit_event(
    event_type => 'approval.rejected',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'rejected' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
      perform "better_supabase"."approval_notify"(v_req."id", 'rejected');
    end if;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_req."status";
    end if;
  end;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at") || jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = v_req."id"
    ), '[]'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.decline_invitation (
  token text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  declined_id uuid;
  tenant text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  update "better_supabase"."invitations" i set "declined_at" = now() where i."token_hash" = encode(extensions.digest(token, 'sha256'), 'hex') and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  returning i."id", i."tenant_id"::text into declined_id, tenant;
  if declined_id is not null then
    perform better_supabase.audit_event(
    event_type => 'invitation.declined',
    category => 'membership',
    target_type => 'invitation',
    record_id => declined_id::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', declined_id, 'organizationId', tenant)
  );
    return true;
  end if;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.decline_invitation_by_id (
  invitation_id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  declined_id uuid;
  tenant text;
  invitee_email text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select lower(u.email) into invitee_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
  if invitee_email is null then
    return false;
  end if;
  update "better_supabase"."invitations" i set "declined_at" = now() where i."id" = invitation_id and lower(i."email") = invitee_email and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  returning i."id", i."tenant_id"::text into declined_id, tenant;
  if declined_id is not null then
    perform better_supabase.audit_event(
    event_type => 'invitation.declined',
    category => 'membership',
    target_type => 'invitation',
    record_id => declined_id::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', declined_id, 'organizationId', tenant)
  );
    return true;
  end if;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.default_service_principal (
  tenant uuid
)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select p."id" from "better_supabase"."service_principals" p
  where p."tenant_id" = default_service_principal.tenant and p."is_default" and p."disabled_at" is null
$function$;

CREATE OR REPLACE FUNCTION better_supabase.delegate_approval (
  request_id uuid,
  to_user    uuid,
  comment    text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = delegate_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  if not "better_supabase"."approval_eligible"(v_req."id") then
    raise exception 'not an approver for this step' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if v_req."subject_type" in ('support_request') then
    raise exception 'the module that filed this request decides who approves it' using errcode = '22023', hint = 'APPROVAL_DELEGATE_INVALID';
  end if;
  if delegate_approval.to_user is null or delegate_approval.to_user = auth.uid() or delegate_approval.to_user = v_req."requested_by" then
    raise exception 'delegate to another user than yourself or the requester' using errcode = '22023', hint = 'APPROVAL_DELEGATE_INVALID';
  end if;
  if not v_req."tenant_id"::text in (
    select t.id::text from permdock.member_organization_ids_for(delegate_approval.to_user) as t(id)
  ) then
    raise exception 'the delegate is not a member of this organization' using errcode = '22023', hint = 'APPROVAL_DELEGATE_INVALID';
  end if;
  insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision", "delegate_to", "comment")
  values (v_req."id", v_req."tenant_id", v_req."step", auth.uid(), 'delegated', delegate_approval.to_user, delegate_approval.comment);
  perform better_supabase.audit_event(
    event_type => 'approval.delegated',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'delegated' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  perform "better_supabase"."approval_notify"(v_req."id", 'delegated');
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.delete_organization (
  organization uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.member_can(auth.uid(), organization, 'organization.delete'), false) then
    raise exception 'Not allowed to delete the organization' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  delete from "better_supabase"."organizations" where "id" = organization;
  if not found then
    return false;
  end if;
  delete from "public"."organization_memberships" where "organization_id" = organization;
  perform better_supabase.audit_event(
    event_type => 'organization.deleted',
    category => 'configuration',
    target_type => 'organization',
    record_id => organization::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('mode', 'hard')
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.delete_ssf_stream (
  id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."ssf_streams";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  delete from "better_supabase"."ssf_streams" s where s."id" = delete_ssf_stream.id returning s.* into v_row;
  if not found then
    return false;
  end if;
  perform better_supabase.audit_event(
    event_type => 'ssf_stream.deleted',
    category => 'security',
    target_type => 'ssf_stream',
    record_id => v_row."id"::text,
    metadata => jsonb_build_object('streamId', v_row."id", 'receiver', v_row."receiver", 'tenant', v_row."tenant")
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.descendants (
  tenant       uuid,
  kind         text,
  subject_type text,
  subject_id   text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('type', w.type, 'id', w.id, 'depth', w.depth) order by w.depth, w.type, w.id), '[]'::jsonb)
  from "better_supabase"."relation_walk"(descendants.tenant, descendants.kind, descendants.subject_type, descendants.subject_id, false, null) w
$function$;

CREATE OR REPLACE FUNCTION better_supabase.disable_service_principal (
  principal  uuid,
  created_by uuid DEFAULT NULL::uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_row "better_supabase"."service_principals";
begin
  select * into v_row from "better_supabase"."service_principals" p where p."id" = disable_service_principal.principal and p."disabled_at" is null for update;
  if not found then
    return false;
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Service principals are managed by the service' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  if disable_service_principal.created_by is not null and not (
    coalesce(better_supabase.member_can(disable_service_principal.created_by, v_row."tenant_id", 'service_accounts.manage'), false)
    and coalesce(better_supabase.can_assign_as(disable_service_principal.created_by, v_row."tenant_id", v_row."role"), false)
  ) then
    raise exception 'You may not manage service principals with this role' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  update "better_supabase"."service_principals" set "disabled_at" = now(), "is_default" = false where "id" = v_row."id";
  delete from "public"."organization_memberships" where "organization_id" = v_row."tenant_id" and "user_id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'service_principal.disabled',
    category => 'access',
    target_type => 'service_principal',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'id', v_row."id"),
    actor_id => coalesce(disable_service_principal.created_by, auth.uid())
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.end_access (
  request_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  SET "IntervalStyle" TO 'iso_8601'
  AS $function$
declare
  v_row "better_supabase"."access_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."access_requests" r where r."id" = end_access.request_id for update;
  if not found then
    raise exception 'access request not found' using errcode = 'P0002', hint = 'ACCESS_REQUEST_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_row."user_id" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'access_requests.manage'), false)) then
    raise exception 'not allowed to end this access' using errcode = '42501', hint = 'ACCESS_REQUEST_FORBIDDEN';
  end if;
  if v_row."granted_at" is null or v_row."ended_at" is not null then
    raise exception 'this access isn''t active' using errcode = '22023', hint = 'ACCESS_NOT_GRANTED';
  end if;
  update "better_supabase"."access_requests" r set "ended_at" = now() where r."id" = v_row."id" returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'access_request.ended',
    category => 'membership',
    target_type => 'user',
    record_id => v_row."user_id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'userId', v_row."user_id", 'role', v_row."role", 'id', v_row."id", 'approvalId', v_row."approval_id", 'expiresAt', v_row."expires_at", 'target', 'role', 'subjectType', null::text, 'subjectId', null::text, 'action', null::text, 'reason', 'revoked')
  );
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'userId', v_row."user_id", 'role', v_row."role", 'previousRole', v_row."previous_role", 'reason', v_row."reason", 'duration', v_row."duration"::text, 'status', 'ended', 'approvalId', v_row."approval_id", 'grantedAt', v_row."granted_at", 'expiresAt', v_row."expires_at", 'endedAt', v_row."ended_at", 'createdAt', v_row."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.end_my_session (
  session uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  delete from auth.sessions s
  where s.id = end_my_session.session
    and s.user_id = (select auth.uid());
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.end_sessions (
  p_user uuid
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  ended int;
begin
  with gone as (
    delete from auth.sessions s where s.user_id = end_sessions.p_user returning s.id
  )
  select count(*)::int into ended from gone;
  delete from auth.refresh_tokens t where t.user_id = end_sessions.p_user::text;
  return ended;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.end_support_session (
  session_id uuid,
  ended_by   text DEFAULT 'admin'::text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  ended jsonb;
begin
  if service and ended_by not in ('admin', 'expired', 'revoked') then
    raise exception 'ended_by must be admin, expired or revoked' using errcode = '22023';
  end if;
  update "better_supabase"."support_sessions" s set "ended_at" = now(), "ended_by" = case
      when service then ended_by
      when s."admin_id" = auth.uid() then 'admin'
      else 'revoked'
    end
  where s."id" = session_id and s."ended_at" is null
    and (service or s."admin_id" = auth.uid()
      or "better_supabase"."is_platform"('impersonation.revoke'))
  returning jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) into ended;
  if not service then
    ended_by := case when (ended ->> 'admin_id')::uuid = auth.uid() then 'admin' else 'revoked' end;
  end if;
  if ended is null then
    return false;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_support_end"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using session_id;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'support_session.ended',
    category => 'security',
    target_type => 'user',
    record_id => ended ->> 'target_user_id',
    tenant => ((ended ->> 'tenant')::uuid)::uuid,
    metadata => jsonb_build_object('session_id', session_id, 'ended_by', ended_by),
    idempotency_key => 'support_session.ended:' || session_id,
    actor_id => case when service then (ended ->> 'admin_id')::uuid else auth.uid() end,
    support_session => session_id,
    impersonated_by => (ended ->> 'admin_id')::uuid,
    impersonation_reason => ended ->> 'reason'
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.ensure_organization_owner()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  -- The row lock serializes concurrent demotions and leaves, so two
  -- transactions can't each remove a different last owner.
  perform 1 from "better_supabase"."organizations" o where o."id" = old."organization_id" for update;
  if found and not exists (
      select 1 from "public"."organization_memberships" m where m."organization_id" = old."organization_id" and m."role" = 'owner'
    ) then
    raise exception 'An organization needs an owner' using errcode = '23514', hint = 'ORGANIZATION_OWNER_REQUIRED';
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.entitlement_members (
  customer text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select distinct m."user_id"::uuid
  from "public"."organization_memberships" m
  where m."organization_id"::text in (select t::text from better_supabase.stripe_customer_tenants(customer) t)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.entitlement_value (
  tenant uuid,
  key    text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select case when tenant::text in (select t.id::text from permdock.member_organization_ids() as t(id)) then better_supabase.tenant_entitlement_value(tenant, key) end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.escalate_approvals (
  max_requests integer DEFAULT 200
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_count integer := 0;
begin
  for v_req in
    select * from "better_supabase"."approval_requests" r
    where r."status" = 'pending'
      and (r."expires_at" is null or r."expires_at" > now())
      and r."policy" -> 'steps' -> r."step" ? 'escalateAfter'
      and not coalesce((r."policy" -> 'steps' -> r."step" ->> 'escalated')::boolean, false)
      and coalesce((
        select max(x."created_at") from "better_supabase"."approval_decisions" x
        where x."request_id" = r."id" and x."step" = r."step" - 1
      ), r."created_at") + (r."policy" -> 'steps' -> r."step" ->> 'escalateAfter')::interval <= now()
    order by r."created_at"
    limit greatest(coalesce(escalate_approvals.max_requests, 200), 1)
    for update skip locked
  loop
    update "better_supabase"."approval_requests" r set "policy" = jsonb_set(r."policy", array['steps', (r."step")::text, 'escalated'], 'true'::jsonb)
    where r."id" = v_req."id"
    returning * into v_req;
    perform better_supabase.audit_event(
    event_type => 'approval.escalated',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'escalated' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
    perform "better_supabase"."approval_notify"(v_req."id", 'escalated');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.expire_access_grants (
  max_grants integer DEFAULT 200
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."access_requests"%rowtype;
  v_count integer := 0;
begin
  for v_row in
    select * from "better_supabase"."access_requests" r
    where r."granted_at" is not null and r."ended_at" is null and r."expires_at" <= now()
    order by r."expires_at"
    limit greatest(coalesce(expire_access_grants.max_grants, 200), 1)
    for update skip locked
  loop
    update "better_supabase"."access_requests" r set "ended_at" = now() where r."id" = v_row."id" returning * into v_row;
    perform better_supabase.audit_event(
    event_type => 'access_request.ended',
    category => 'membership',
    target_type => 'user',
    record_id => v_row."user_id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'userId', v_row."user_id", 'role', v_row."role", 'id', v_row."id", 'approvalId', v_row."approval_id", 'expiresAt', v_row."expires_at", 'target', 'role', 'subjectType', null::text, 'subjectId', null::text, 'action', null::text, 'reason', 'expired')
  );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.expire_approvals (
  max_requests integer DEFAULT 500
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_count integer := 0;
begin
  for v_req in
    update "better_supabase"."approval_requests" r set "status" = 'expired', "decided_at" = now()
    where r."id" in (
      select x."id" from "better_supabase"."approval_requests" x
      where x."status" = 'pending' and x."expires_at" <= now()
      order by x."expires_at"
      limit greatest(coalesce(expire_approvals.max_requests, 500), 1)
      for update skip locked
    )
    returning r.*
  loop
    null;
    perform "better_supabase"."approval_notify"(v_req."id", 'expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.expire_support_sessions()
  RETURNS SETOF jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  expired_id uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role expires support sessions' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
  end if;
  for expired_id in
    select s."id" from "better_supabase"."support_sessions" s
    where s."ended_at" is null and s."expires_at" <= now()
    order by s."expires_at"
    for update skip locked
  loop
    if "better_supabase"."end_support_session"(expired_id, 'expired') then
      return next (select jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) from "better_supabase"."support_sessions" s where s."id" = expired_id);
    end if;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.feature_claims (
  user_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_object_agg(r.tenant, to_jsonb(r.keys)), '{}'::jsonb)
  from (
    select t.id::text as tenant, e.keys
    from permdock.member_organization_ids_for(feature_claims.user_id) as t(id)
    cross join lateral (select better_supabase.tenant_entitlements(t.id::uuid) as keys) e
    where cardinality(e.keys) > 0
    order by 1
  ) r
$function$;

CREATE OR REPLACE FUNCTION better_supabase.forget_ssf_received (
  issuer text,
  jti    text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  delete from "better_supabase"."ssf_received" x where x."issuer" = forget_ssf_received.issuer and x."jti" = forget_ssf_received.jti;
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_access_request (
  request_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET "IntervalStyle" TO 'iso_8601'
  AS $function$
declare
  v_row "better_supabase"."access_requests"%rowtype;
  v_approval "better_supabase"."approval_requests"%rowtype;
begin
  select * into v_row from "better_supabase"."access_requests" r where r."id" = get_access_request.request_id;
  if not found or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_row."user_id" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'access_requests.read'), false)) then
    raise exception 'access request not found' using errcode = 'P0002', hint = 'ACCESS_REQUEST_NOT_FOUND';
  end if;
  select * into v_approval from "better_supabase"."approval_requests" x where x."id" = v_row."approval_id";
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'userId', v_row."user_id", 'role', v_row."role", 'previousRole', v_row."previous_role", 'reason', v_row."reason", 'duration', v_row."duration"::text, 'status', case when v_row."ended_at" is not null then 'ended' when v_row."granted_at" is not null then 'granted' else coalesce(v_approval."status", 'pending') end, 'approvalId', v_row."approval_id", 'grantedAt', v_row."granted_at", 'expiresAt', v_row."expires_at", 'endedAt', v_row."ended_at", 'createdAt', v_row."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_approval (
  request_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = get_approval.request_id;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_req."requested_by" = auth.uid(), false) or "better_supabase"."approval_eligible"(v_req."id")
    or (coalesce(better_supabase.can('tenant', v_req."tenant_id", 'approvals.read'), false) and (not v_req."subject_type" in ('support_request') and (v_req."subject_type" = 'access_request' or true)))) then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at") || jsonb_build_object(
    'canDecide', "better_supabase"."approval_eligible"(v_req."id"),
    'decisions', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'step', x."step", 'approver', x."approver", 'decision', x."decision", 'delegateTo', x."delegate_to", 'comment', x."comment", 'createdAt', x."created_at") order by x."created_at", x."id")
      from "better_supabase"."approval_decisions" x where x."request_id" = v_req."id"
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = v_req."id"
    ), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_approvals (
  request_ids uuid[]
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'subjectType', r."subject_type", 'subjectId', r."subject_id", 'action', r."action", 'status', r."status", 'step', r."step", 'steps', r."policy" -> 'steps', 'requestedBy', r."requested_by", 'reason', r."reason", 'payload', r."payload", 'expiresAt', r."expires_at", 'decidedAt', r."decided_at", 'mode', coalesce(r."policy" ->> 'mode', 'authorize'), 'fingerprint', r."fingerprint", 'consumedAt', r."consumed_at", 'createdAt', r."created_at") || jsonb_build_object(
      'canDecide', "better_supabase"."approval_eligible"(r."id"),
      'decisions', coalesce((
        select jsonb_agg(jsonb_build_object('id', x."id", 'step', x."step", 'approver', x."approver", 'decision', x."decision", 'delegateTo', x."delegate_to", 'comment', x."comment", 'createdAt', x."created_at") order by x."created_at", x."id")
        from "better_supabase"."approval_decisions" x where x."request_id" = r."id"
      ), '[]'::jsonb),
      'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = r."id"
    ), '[]'::jsonb)
    ) order by array_position(get_approvals.request_ids, r."id")), '[]'::jsonb)
    from "better_supabase"."approval_requests" r
    where r."id" = any (get_approvals.request_ids)
      and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(r."requested_by" = auth.uid(), false) or "better_supabase"."approval_eligible"(r."id")
        or (coalesce(better_supabase.can('tenant', r."tenant_id", 'approvals.read'), false) and (not r."subject_type" in ('support_request') and (r."subject_type" = 'access_request' or true))))
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_organization_settings (
  tenant uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_object_agg(s."key", s."value"), '{}'::jsonb)
  from "better_supabase"."organization_settings" s
  where s."tenant_id" = get_organization_settings.tenant
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_platform_settings()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_object_agg(s."key", s."value"), '{}'::jsonb)
  from "better_supabase"."platform_settings" s
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_support_session (
  session_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."support_sessions"%rowtype;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')
      or "better_supabase"."is_platform"('impersonation.read')) then
    raise exception 'not allowed to read support sessions' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."support_sessions" s where s."id" = get_support_session.session_id;
  if not found then
    raise exception 'support session not found' using errcode = 'P0002', hint = 'IMPERSONATION_SESSION_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'id', v_row."id",
    'admin_id', v_row."admin_id",
    'target_user_id', v_row."target_id",
    'reason', v_row."reason",
    'tenant', v_row."tenant_id",
    'read_only', v_row."read_only",
    'started_at', v_row."started_at",
    'expires_at', v_row."expires_at",
    'ended_at', v_row."ended_at",
    'ended_by', v_row."ended_by",
    'metadata', v_row."metadata"
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_team (
  team uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_tenant uuid;
  v_row jsonb;
begin
  select x."tenant_id", jsonb_build_object(
    'id', x."id",
    'name', x."name",
    'slug', x."slug",
    'description', x."description",
    'status', x."status",
    'member_ids', coalesce((
      select jsonb_agg(m."user_id" order by m."created_at")
      from "better_supabase"."team_members" m
      where m."team_id" = x."id"
    ), '[]'::jsonb)
  )
    into v_tenant, v_row
    from "better_supabase"."teams" x
    where x."id" = get_team.team;
  if v_row is null then
    return null;
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'teams.read'), false)) then
    raise exception 'not allowed to read teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.get_user_settings()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_object_agg(s."key", s."value"), '{}'::jsonb)
  from "better_supabase"."user_settings" s
  where s."user_id" = auth.uid()
$function$;

CREATE OR REPLACE FUNCTION better_supabase.grant_access_request (
  request_id uuid
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."access_requests"%rowtype;
  v_previous text;
begin
  select * into v_row from "better_supabase"."access_requests" r where r."id" = grant_access_request.request_id for update;
  if not found or v_row."granted_at" is not null then
    return;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_access_grant"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
  -- The authorization provider's adapter grants the role from the event.
  null;
  update "better_supabase"."access_requests" r
  set "previous_role" = v_previous,
      "granted_at" = now(),
      "expires_at" = case when v_row."duration" is null then null else now() + v_row."duration" end
  where r."id" = v_row."id"
  returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'access_request.approved',
    category => 'membership',
    target_type => 'user',
    record_id => v_row."user_id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'userId', v_row."user_id", 'role', v_row."role", 'id', v_row."id", 'approvalId', v_row."approval_id", 'expiresAt', v_row."expires_at", 'target', 'role', 'subjectType', null::text, 'subjectId', null::text, 'action', null::text)
  );
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_access_grant"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.guard_membership()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if not (current_user in ('anon', 'authenticated')) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new."role" is not distinct from old."role" then
    return new;
  end if;
  perform "better_supabase"."guard_membership_role"(
    new."organization_id", new."user_id", new."role"::text,
    case when tg_op = 'UPDATE' then old."organization_id" end,
    case when tg_op = 'UPDATE' then old."role"::text end
  );
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.guard_membership_role (
  target_tenant   uuid,
  target_member   uuid,
  target_role     text,
  previous_tenant uuid,
  previous_role   text
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if target_member = auth.uid() then
    raise exception 'You cannot change your own role' using errcode = '42501', hint = 'ORGANIZATION_SELF_ROLE';
  end if;
  if not better_supabase.can_assign(target_tenant, target_role::text)
    or (previous_tenant is not null and not better_supabase.can_assign(previous_tenant, previous_role::text)) then
    raise exception 'That role is above your own' using errcode = '42501', hint = 'ORGANIZATION_ROLE_CEILING';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.has_entitlement (
  tenant uuid,
  key    text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select tenant::text in (select t.id::text from permdock.member_organization_ids() as t(id))
    and key = any (better_supabase.tenant_entitlements(tenant))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.has_scope (
  scope text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select case
    when auth.jwt() -> 'api_key' is null then true
    else coalesce(auth.jwt() -> 'api_key' -> 'scopes', '[]'::jsonb) ?| array['*', has_scope.scope]
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.import_organization_profile (
  run        uuid,
  item       jsonb,
  subject_id text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_data jsonb := import_organization_profile.item -> 'data';
  v_tenant uuid := (import_organization_profile.item ->> 'tenant')::uuid;
  v_vat text := nullif(upper(btrim(v_data ->> 'vatId')), '');
  v_warnings jsonb := '[]'::jsonb;
  v_account jsonb;
  v_iban text;
  v_primary boolean;
  v_id uuid;
  v_updated timestamptz;
begin
  if jsonb_typeof(v_data) is distinct from 'object' then
    raise exception 'an organization profile needs data' using errcode = '22023', hint = 'IMPORT_ITEM_INVALID';
  end if;
  if v_vat ~ '^[A-Z]{2}$' then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'IMPORT_VAT_PREFIX', 'message', 'a VAT number that is only a country prefix was skipped'));
    v_vat := null;
  end if;
  insert into "better_supabase"."organization_profiles" ("tenant_id") values (v_tenant) on conflict ("tenant_id") do nothing;
  if exists (
    select 1 from "better_supabase"."organization_profiles" x
    where x."tenant_id" = v_tenant
      and (v_vat is null or x."vat_id" is not distinct from v_vat)
      and (v_data ->> 'registrationId' is null or x."registration_id" is not distinct from nullif(btrim(v_data ->> 'registrationId'), ''))
      and (v_data ->> 'defaultRate' is null or x."default_rate" is not distinct from (v_data ->> 'defaultRate')::numeric)
      and (v_data ->> 'currency' is null or x."currency" is not distinct from nullif(btrim(v_data ->> 'currency'), ''))
  ) then
    v_updated := (select x."updated_at" from "better_supabase"."organization_profiles" x where x."tenant_id" = v_tenant);
  else
    update "better_supabase"."organization_profiles" x set
      "vat_id" = coalesce(v_vat, x."vat_id"),
      "registration_id" = coalesce(nullif(btrim(v_data ->> 'registrationId'), ''), x."registration_id"),
      "default_rate" = coalesce((v_data ->> 'defaultRate')::numeric, x."default_rate"),
      "currency" = coalesce(nullif(btrim(v_data ->> 'currency'), ''), x."currency"),
      "updated_at" = now()
    where x."tenant_id" = v_tenant
    returning x."updated_at" into v_updated;
  end if;
  if jsonb_typeof(v_data -> 'accounts') = 'array' then
    for v_account in select value from jsonb_array_elements(v_data -> 'accounts') loop
      v_iban := upper(regexp_replace(coalesce(v_account ->> 'iban', ''), '\s', '', 'g'));
      if not better_supabase.validate_iban(v_iban) then
        raise exception 'a payment account needs a valid IBAN' using errcode = '22023', hint = 'IMPORT_ITEM_INVALID';
      end if;
      v_primary := case when v_account ? 'isPrimary' then (v_account ->> 'isPrimary')::boolean else null end;
      select x."id" into v_id from "better_supabase"."organization_payment_accounts" x
      where x."tenant_id" = v_tenant and x."iban" = v_iban
        and x."bic" is not distinct from coalesce(nullif(upper(btrim(v_account ->> 'bic')), ''), x."bic")
        and x."holder" is not distinct from coalesce(nullif(btrim(v_account ->> 'holder'), ''), x."holder")
        and x."label" is not distinct from coalesce(nullif(btrim(v_account ->> 'label'), ''), x."label")
        and (v_primary is null or x."is_primary" = v_primary);
      if v_id is null then
        if v_primary is true then
          update "better_supabase"."organization_payment_accounts" x set "is_primary" = false where x."tenant_id" = v_tenant and x."iban" <> v_iban;
        end if;
        insert into "better_supabase"."organization_payment_accounts" ("tenant_id", "iban", "bic", "holder", "label", "is_primary")
        values (v_tenant, v_iban, nullif(upper(btrim(v_account ->> 'bic')), ''), nullif(btrim(v_account ->> 'holder'), ''),
          nullif(btrim(v_account ->> 'label'), ''), coalesce(v_primary, false))
        on conflict ("tenant_id", "iban") do update set
          "bic" = coalesce(excluded."bic", "better_supabase"."organization_payment_accounts"."bic"),
          "holder" = coalesce(excluded."holder", "better_supabase"."organization_payment_accounts"."holder"),
          "label" = coalesce(excluded."label", "better_supabase"."organization_payment_accounts"."label"),
          "is_primary" = case when v_primary is true then true else "better_supabase"."organization_payment_accounts"."is_primary" end,
          "updated_at" = now();
      end if;
    end loop;
  end if;
  return jsonb_build_object('subjectId', v_tenant, 'updatedAt', coalesce(v_updated, now()), 'warnings', v_warnings);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.install_default_rules (
  tenant uuid
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_count integer;
begin
  insert into "better_supabase"."automations" ("tenant_id", "subject_type", "trigger", "name", "description", "conditions", "actions", "enabled", "default_key", "created_by", "updated_by")
  select install_default_rules.tenant, x."subject_type", x."trigger", x."name", x."description", x."conditions", x."actions", x."enabled", x."key", null, null
  from "better_supabase"."automation_defaults" x
  where not exists (
    select 1 from "better_supabase"."automations" y where y."tenant_id" = install_default_rules.tenant and y."default_key" = x."key"
  )
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.interactive_only (
  permission text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select coalesce(permission = any (array['impersonation.start', 'organization.delete', 'organization.transfer_ownership', 'platform.invite', 'sso.manage']::text[]), false)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.interactive_only_role (
  role text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select coalesce(role = 'owner', false)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.invitation_extra (
  invitation uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  hook regprocedure := to_regprocedure('"public"."invitation_preview_extra"(uuid)');
  extra jsonb;
begin
  if hook is null or invitation is null then
    return '{}'::jsonb;
  end if;
  -- Not a literal name, so plpgsql_check passes without the hook.
  execute format('select %s($1)', hook::oid::regproc) into extra using invitation;
  return coalesce(extra, '{}'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.invitation_preview (
  token text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  preview jsonb;
  invitation uuid;
begin
  select jsonb_build_object(
    'status', case
    when i."accepted_at" is not null then 'accepted'
    when i."declined_at" is not null then 'declined'
    when i."revoked_at" is not null then 'revoked'
    when i."expires_at" < now() then 'expired'
    else 'pending'
  end,
    'email', i."email",
    'role', i."role",
    'tenant', i."tenant_id",
    'expires_at', i."expires_at",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = i."tenant_id"),
    'prefill', '{}'::jsonb
  ), i."id"
  into preview, invitation
  from "better_supabase"."invitations" i
  where i."token_hash" = encode(extensions.digest(invitation_preview.token, 'sha256'), 'hex');
  if preview is not null then
    preview := preview || "better_supabase"."invitation_extra"(invitation);
  end if;
  return preview;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.invitation_tenant_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  return query select better_supabase.tenant_ids_with('members.invite');
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.invite_member (
  tenant        uuid,
  invitee_email text,
  invitee_role  text,
  valid_for     interval DEFAULT '7 days'::interval,
  prefill       jsonb    DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  token text := encode(extensions.gen_random_bytes(24), 'hex');
  created "better_supabase"."invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if valid_for is null or valid_for <= interval '0' or valid_for > '30 days'::interval then
    raise exception 'An invitation is valid for at most %', '30 days' using errcode = '22023', hint = 'INVITATION_VALIDITY';
  end if;
  if tenant is null then
    raise exception 'Platform invitations need platform roles: blocks.permissions.model ''catalog'' with platform assignments, or blocks.invitations.options.platformRoles under ''provider''' using errcode = '0A000', hint = 'INVITATION_SCOPE_UNSUPPORTED';
  end if;
  invitee_role := coalesce(invitee_role, 'member');
  if not service and not coalesce(better_supabase.member_can(auth.uid(), tenant, 'members.invite'), false) then
    raise exception 'Not allowed to invite members' using errcode = '42501', hint = 'INVITATION_FORBIDDEN';
  end if;
  if better_supabase.tenant_disabled(tenant) or not exists (select 1 from "better_supabase"."organizations" o where o."id" = tenant) then
    raise exception 'The organization is not active' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if false then
    raise exception 'Unknown role %', invitee_role using errcode = '23514', hint = 'INVITATION_ROLE_UNKNOWN';
  end if;
  if not service and not better_supabase.can_assign(tenant, (invitee_role)::text) then
    raise exception 'That role is above your own' using errcode = '42501', hint = 'INVITATION_ROLE_FORBIDDEN';
  end if;
  if exists (
    select 1 from "public"."organization_memberships" m join auth.users u on u.id = m."user_id"
    where m."organization_id" = tenant and lower(u.email) = lower(btrim(invitee_email))
  ) then
    raise exception '% is already a member', invitee_email using errcode = '23505', hint = 'INVITATION_ALREADY_MEMBER';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_invitation_create"(uuid, text, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text, $3::text)', v_hook::oid::regproc)
        using tenant, invitee_email, invitee_role;
    end if;
  end;
  delete from "better_supabase"."invitations" i
  where i."tenant_id" = tenant
    and lower(i."email") = lower(btrim(invitee_email))
    and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null;
  insert into "better_supabase"."invitations" ("tenant_id", "email", "role", "token_hash", "invited_by", "expires_at")
  values (tenant, lower(btrim(invitee_email)), invitee_role, encode(extensions.digest(token, 'sha256'), 'hex'), auth.uid(), now() + valid_for)
  returning * into created;
  perform better_supabase.audit_event(
    event_type => 'invitation.created',
    category => 'membership',
    target_type => 'invitation',
    record_id => created."id"::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', created."id", 'organizationId', tenant::text, 'email', created."email", 'role', created."role")
  );
  return (jsonb_build_object(
    'id', created."id",
    'tenant', created."tenant_id",
    'email', created."email",
    'role', created."role",
    'expires_at', created."expires_at",
    'created_at', created."created_at",
    'invited_by', created."invited_by",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = created."tenant_id"),
    'prefill', '{}'::jsonb,
    'token', token
  ) || "better_supabase"."invitation_extra"(created."id"));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.invite_within_seats (
  tenant        uuid,
  invitee_email text,
  invitee_role  text,
  valid_for     interval DEFAULT '7 days'::interval
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  used integer;
  cap jsonb;
begin
  cap := "better_supabase"."entitlement_value"(tenant, 'seats');
  select count(*) into used from "public"."organization_memberships" m where m."organization_id" = tenant;
  if cap is not null and jsonb_typeof(cap) = 'number' and used >= (cap #>> '{}')::numeric then
    raise exception 'The plan has no seat left' using errcode = '22023', hint = 'INVITATION_NO_SEAT';
  end if;
  return "better_supabase"."invite_member"(tenant, invitee_email, invitee_role, valid_for);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.is_approved (
  subject_type text,
  subject_id   text,
  action       text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce((
    select x."status"::text in ('approved', 'consumed') from "better_supabase"."approval_requests" x
    where x."subject_type" = is_approved.subject_type and x."subject_id" = is_approved.subject_id and x."action" = is_approved.action
    order by x."created_at" desc limit 1
  ), false)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.last_sign_ins (
  p_users uuid[]
)
  RETURNS TABLE (
    user_id         uuid,
    last_sign_in_at timestamp with time zone
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select u.id, u.last_sign_in_at
  from auth.users u
  where u.id = any(p_users)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.leave_organization (
  organization uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  delete from "public"."organization_memberships" where "organization_id" = organization and "user_id" = me;
  if not found then
    raise exception 'Not a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_member_change"(uuid, uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text)', v_hook::oid::regproc)
        using organization, me, 'left';
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.member_left',
    category => 'membership',
    target_type => 'user',
    record_id => me::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', me)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.link (
  tenant      uuid,
  kind        text,
  source_type text,
  source_id   text,
  target_type text,
  target_id   text,
  data        jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_kind text;
  v_inverted boolean;
  v_acyclic boolean;
  v_single boolean;
  v_symmetric boolean;
  v_source_type text;
  v_source_id text;
  v_target_type text;
  v_target_id text;
  v_id uuid;
  v_created boolean := false;
  v_previous jsonb;
  v_replaced jsonb;
  v_old "better_supabase"."relations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (auth.role() = 'service_role' or coalesce(better_supabase.can('tenant', link.tenant, 'relations.manage'), false)) then
    raise exception 'not allowed to link records' using errcode = '42501', hint = 'RELATION_FORBIDDEN';
  end if;
  if link.data is not null and jsonb_typeof(link.data) <> 'object' then
    raise exception 'data must be an object' using errcode = '22023', hint = 'RELATION_INVALID';
  end if;
  if link.source_type = link.target_type and link.source_id = link.target_id then
    raise exception 'a record can''t link to itself' using errcode = '22023', hint = 'RELATION_SELF';
  end if;

  select k.canonical, k.inverted, k.acyclic, k.single, k.both_ways
    into v_kind, v_inverted, v_acyclic, v_single, v_symmetric
    from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = link.kind;
  if v_kind is null then
    raise exception 'unknown relation kind' using errcode = '22023', hint = 'RELATION_KIND_UNKNOWN';
  end if;
  if v_inverted then
    v_source_type := link.target_type; v_source_id := link.target_id;
    v_target_type := link.source_type; v_target_id := link.source_id;
  else
    v_source_type := link.source_type; v_source_id := link.source_id;
    v_target_type := link.target_type; v_target_id := link.target_id;
  end if;
  if v_symmetric and (v_source_type, v_source_id) > (v_target_type, v_target_id) then
    select v_target_type, v_target_id, v_source_type, v_source_id
      into v_source_type, v_source_id, v_target_type, v_target_id;
  end if;
  if not (true)
     or not (true) then
    raise exception 'not allowed to link these records' using errcode = '42501', hint = 'RELATION_SUBJECT_FORBIDDEN';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_relation_link"(uuid, text, text, text, text, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text)', v_hook::oid::regproc)
        using link.tenant, v_kind, v_source_type, v_source_id, v_target_type, v_target_id;
    end if;
  end;
  if v_acyclic or v_single then
    perform pg_advisory_xact_lock(hashtext(link.tenant::text || ':relation:' || v_kind));
  end if;
  select "id", "data" into v_id, v_previous from "better_supabase"."relations"
    where "tenant_id" = link.tenant and "kind" = v_kind
      and "source_type" = v_source_type and "source_id" = v_source_id
      and "target_type" = v_target_type and "target_id" = v_target_id;
  if v_id is null then
    if v_acyclic and exists (
      with recursive reach(t, i, depth) as (
        select v_target_type, v_target_id, 0
        union
        select r."target_type", r."target_id", reach.depth + 1
        from "better_supabase"."relations" r join reach
          on r."source_type" = reach.t and r."source_id" = reach.i
        where r."tenant_id" = link.tenant and r."kind" = v_kind and reach.depth < 1000
      )
      select 1 from reach where t = v_source_type and i = v_source_id
    ) then
      raise exception 'this link would create a cycle' using errcode = '23514', hint = 'RELATION_CYCLE';
    end if;
    if v_single then
      delete from "better_supabase"."relations"
        where "tenant_id" = link.tenant and "kind" = v_kind
          and "source_type" = v_source_type and "source_id" = v_source_id
        returning * into v_old;
      if v_old."id" is not null then
        v_replaced := jsonb_build_object('targetType', v_old."target_type", 'targetId', v_old."target_id", 'data', v_old."data");
        null;
      end if;
    end if;
    insert into "better_supabase"."relations" ("tenant_id", "kind", "source_type", "source_id", "target_type", "target_id", "data", "created_by")
    values (link.tenant, v_kind, v_source_type, v_source_id, v_target_type, v_target_id, coalesce(link.data, '{}'::jsonb), auth.uid())
    returning "id" into v_id;
    v_created := true;
    null;
  elsif link.data is not null then
    update "better_supabase"."relations" set "data" = link.data where "id" = v_id;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_relation_link"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_id;
    end if;
  end;
  return jsonb_build_object(
    'id', v_id, 'kind', v_kind, 'created', v_created,
    'sourceType', v_source_type, 'sourceId', v_source_id,
    'targetType', v_target_type, 'targetId', v_target_id,
    'previousData', case when v_created then null else v_previous end,
    'replaced', v_replaced);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_access_requests (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  SET "IntervalStyle" TO 'iso_8601'
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(list_access_requests.filters, '{}'::jsonb);
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('status', 'role') then
      raise exception 'facet is one of status, role' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
    end if;
    with s as (
      select (case v_facet when 'status' then (r.bs_status)::text when 'role' then (r."role")::text end) as v
      from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('createdAt') then
    raise exception 'sort is one of createdAt' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'userId', r."user_id", 'role', r."role", 'previousRole', r."previous_role", 'reason', r."reason", 'duration', r."duration"::text, 'status', r.bs_status, 'approvalId', r."approval_id", 'grantedAt', r."granted_at", 'expiresAt', r."expires_at", 'endedAt', r."ended_at", 'createdAt', r."created_at") as j, jsonb_build_array((r."created_at")::text, (r."id")::text) as k
    from (
      select * from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
        and (v_after is null or (r."created_at" >= (v_after ->> 0)::timestamptz and ((r."created_at" > (v_after ->> 0)::timestamptz) or (r."created_at" = (v_after ->> 0)::timestamptz and r."id" < (v_after ->> 1)::uuid))))
      order by r."created_at" asc, r."id" desc
      limit v_limit + 1 offset v_offset
    ) r
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'userId', r."user_id", 'role', r."role", 'previousRole', r."previous_role", 'reason', r."reason", 'duration', r."duration"::text, 'status', r.bs_status, 'approvalId', r."approval_id", 'grantedAt', r."granted_at", 'expiresAt', r."expires_at", 'endedAt', r."ended_at", 'createdAt', r."created_at") as j, jsonb_build_array((r."created_at")::text, (r."id")::text) as k
    from (
      select * from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
        and (v_after is null or (r."created_at", r."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by r."created_at" desc, r."id" desc
      limit v_limit + 1 offset v_offset
    ) r
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'userId', r."user_id", 'role', r."role", 'previousRole', r."previous_role", 'reason', r."reason", 'duration', r."duration"::text, 'status', r.bs_status, 'approvalId', r."approval_id", 'grantedAt', r."granted_at", 'expiresAt', r."expires_at", 'endedAt', r."ended_at", 'createdAt', r."created_at") as j, jsonb_build_array((r."created_at")::text, (r."id")::text) as k
    from (
      select * from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
        and (v_after is null or (r."created_at" >= (v_after ->> 0)::timestamptz and ((r."created_at" > (v_after ->> 0)::timestamptz) or (r."created_at" = (v_after ->> 0)::timestamptz and r."id" < (v_after ->> 1)::uuid))))
      order by r."created_at" asc, r."id" desc
      limit v_limit + 1 offset v_offset
    ) r
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ACCESS_REQUEST_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', r."id", 'organizationId', r."tenant_id", 'userId', r."user_id", 'role', r."role", 'previousRole', r."previous_role", 'reason', r."reason", 'duration', r."duration"::text, 'status', r.bs_status, 'approvalId', r."approval_id", 'grantedAt', r."granted_at", 'expiresAt', r."expires_at", 'endedAt', r."ended_at", 'createdAt', r."created_at") as j, jsonb_build_array((r."created_at")::text, (r."id")::text) as k
    from (
      select * from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
        and (v_after is null or (r."created_at", r."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by r."created_at" desc, r."id" desc
      limit v_limit + 1 offset v_offset
    ) r
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from (select q.*, case when q."ended_at" is not null then 'ended' when q."granted_at" is not null then 'granted' else coalesce(x."status", 'pending') end as bs_status from "better_supabase"."access_requests" q left join "better_supabase"."approval_requests" x on x."id" = q."approval_id") r
      where r."tenant_id" = list_access_requests.tenant
        and (r."user_id" = auth.uid() or (not coalesce(nullif(coalesce(v_filters #>> '{mine,0}', v_filters ->> 'mine'), '') = 'true', false) and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_access_requests.tenant, 'access_requests.read'), false))))
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (r.bs_status)::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or r."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'before' is not null and jsonb_typeof(v_filters -> 'before') <> 'null' and not (jsonb_typeof(v_filters -> 'before') = 'array' and jsonb_array_length(v_filters -> 'before') = 0)) or r."created_at" < (nullif(coalesce(v_filters #>> '{before,0}', v_filters ->> 'before'), ''))::timestamptz)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_api_keys (
  tenant uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  -- One plain filter per branch, so each reads through the tenant or user index.
  if list_api_keys.tenant is null then
    return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', k."id",
    'organization_id', k."tenant_id",
    'user_id', k."user_id",
    'name', k."name",
    'prefix', k."prefix",
    'public_id', k."public_id",
    'scopes', to_jsonb(k."scopes"),
    'kind', k."kind",
    'rate_limit', k."rate_limit",
    'expires_at', k."expires_at",
    'last_used_at', k."last_used_at",
    'revoked_at', k."revoked_at",
    'rotated_from', k."rotated_from",
    'created_by', k."created_by",
    'created_at', k."created_at",
    'state', case
      when k."revoked_at" is not null and k."revoked_at" <= now() then 'revoked'
      when k."expires_at" is not null and k."expires_at" <= now() then 'expired'
      when k."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = k."id" order by s."created_at" desc limit 1)
  ) order by k."created_at" desc), '[]'::jsonb)
      from "better_supabase"."api_keys" k where k."user_id" = auth.uid());
  end if;
  if coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_api_keys.tenant, 'api_keys.manage'), false) then
    return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', k."id",
    'organization_id', k."tenant_id",
    'user_id', k."user_id",
    'name', k."name",
    'prefix', k."prefix",
    'public_id', k."public_id",
    'scopes', to_jsonb(k."scopes"),
    'kind', k."kind",
    'rate_limit', k."rate_limit",
    'expires_at', k."expires_at",
    'last_used_at', k."last_used_at",
    'revoked_at', k."revoked_at",
    'rotated_from', k."rotated_from",
    'created_by', k."created_by",
    'created_at', k."created_at",
    'state', case
      when k."revoked_at" is not null and k."revoked_at" <= now() then 'revoked'
      when k."expires_at" is not null and k."expires_at" <= now() then 'expired'
      when k."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = k."id" order by s."created_at" desc limit 1)
  ) order by k."created_at" desc), '[]'::jsonb)
      from "better_supabase"."api_keys" k where k."tenant_id" = list_api_keys.tenant);
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', k."id",
    'organization_id', k."tenant_id",
    'user_id', k."user_id",
    'name', k."name",
    'prefix', k."prefix",
    'public_id', k."public_id",
    'scopes', to_jsonb(k."scopes"),
    'kind', k."kind",
    'rate_limit', k."rate_limit",
    'expires_at', k."expires_at",
    'last_used_at', k."last_used_at",
    'revoked_at', k."revoked_at",
    'rotated_from', k."rotated_from",
    'created_by', k."created_by",
    'created_at', k."created_at",
    'state', case
      when k."revoked_at" is not null and k."revoked_at" <= now() then 'revoked'
      when k."expires_at" is not null and k."expires_at" <= now() then 'expired'
      when k."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = k."id" order by s."created_at" desc limit 1)
  ) order by k."created_at" desc), '[]'::jsonb)
    from "better_supabase"."api_keys" k where k."tenant_id" = list_api_keys.tenant and k."user_id" = auth.uid());
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_approvals (
  tenant       uuid,
  status       text                     DEFAULT 'pending'::text,
  assigned     boolean                  DEFAULT false,
  subject_type text                     DEFAULT NULL::text,
  subject_id   text                     DEFAULT NULL::text,
  page_size    integer                  DEFAULT 50,
  before       timestamp with time zone DEFAULT NULL::timestamp WITH time zone
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_rows jsonb;
  v_read boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_approvals.tenant, 'approvals.read'), false);
begin
  select coalesce(jsonb_agg(t.j order by t.at desc, t.id), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at") as j, x."created_at" as at, x."id" as id
    from "better_supabase"."approval_requests" x
    where x."tenant_id" = list_approvals.tenant
      and (list_approvals.status is null or x."status" = list_approvals.status)
      and (list_approvals.subject_type is null or x."subject_type" = list_approvals.subject_type)
      and (list_approvals.subject_id is null or x."subject_id" = list_approvals.subject_id)
      and (list_approvals.before is null or x."created_at" < list_approvals.before)
      and case
        when list_approvals.assigned then x."id" in (select "better_supabase"."approval_eligible_ids"(list_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(list_approvals.tenant))
      end
    order by x."created_at" desc, x."id"
    limit least(greatest(coalesce(list_approvals.page_size, 50), 1), 200)
  ) t;
  return v_rows;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_members (
  organization uuid
)
  RETURNS TABLE (
    user_id uuid,
    role    text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not coalesce(better_supabase.member_can((select auth.uid()), organization, 'members.read'), false) then
    raise exception 'Not allowed to list members' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  return query
  select m."user_id", m."role"::text
  from "public"."organization_memberships" m
  where m."organization_id" = organization
  order by m."user_id";
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_my_organizations()
  RETURNS TABLE (
    id   uuid,
    name text,
    slug text,
    role text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select o."id", o."name", o."slug", m."role"::text
  from "public"."organization_memberships" m
  join "better_supabase"."organizations" o on o."id" = m."organization_id"
  where m."user_id" = (select auth.uid()) and o."deleted_at" is null and o."disabled_at" is null
    and not better_supabase.tenant_disabled(o."id")
  order by o."name"
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_my_sessions()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'createdAt', s.created_at,
    'lastActiveAt', coalesce(s.updated_at, s.created_at),
    'userAgent', s.user_agent,
    'ip', host(s.ip),
    'aal', s.aal,
    'current', s.id::text = auth.jwt() ->> 'session_id'
  ) order by coalesce(s.updated_at, s.created_at) desc), '[]'::jsonb)
  from auth.sessions s
  where s.user_id = (select auth.uid())
    and (s.not_after is null or s.not_after > now())
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_organization_domains (
  tenant uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.can('tenant', list_organization_domains.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s domains' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) order by x."domain"), '[]'::jsonb)
    from "better_supabase"."sso_domains" x where x."tenant_id" = list_organization_domains.tenant
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_organization_invitations (
  organization uuid
)
  RETURNS TABLE (
    id         uuid,
    email      text,
    role       text,
    expires_at timestamp with time zone
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not coalesce(better_supabase.member_can((select auth.uid()), organization, 'members.invite'), false) then
    raise exception 'Not allowed to list invitations' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  return query
  select i."id", i."email", i."role"::text, i."expires_at"
  from "better_supabase"."invitations" i
  where i."tenant_id" = organization and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null and i."expires_at" >= now()
  order by i."expires_at" desc;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_sso_providers (
  tenant uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.can('tenant', list_sso_providers.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(x.*) order by x."created_at"), '[]'::jsonb)
    from "better_supabase"."sso_providers" x where x."tenant_id" = list_sso_providers.tenant
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_support_sessions (
  admin_id uuid    DEFAULT NULL::uuid,
  target   uuid    DEFAULT NULL::uuid,
  active   boolean DEFAULT NULL::boolean,
  max_rows integer DEFAULT 50
)
  RETURNS SETOF jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  )
  from "better_supabase"."support_sessions" s
  where (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')
      or "better_supabase"."is_platform"('impersonation.read'))
    and ($1 is null or s."admin_id" = $1)
    and ($2 is null or s."target_id" = $2)
    and ($3 is null
      or $3 = (s."ended_at" is null and s."expires_at" > now()))
  order by s."started_at" desc
  limit $4
$function$;

CREATE OR REPLACE FUNCTION better_supabase.list_teams (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(list_teams.filters, '{}'::jsonb);
  v_search text := case when nullif(trim(v_filters ->> 'search'), '') is null then null
    else '%' || replace(replace(replace(trim(v_filters ->> 'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', list_teams.tenant, 'teams.read'), false)) then
    raise exception 'not allowed to read teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('status') then
      raise exception 'facet is one of status' using errcode = '22023', hint = 'TEAM_INVALID';
    end if;
    with s as (
      select (case v_facet when 'status' then (x."status")::text end) as v
      from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('name', 'createdAt') then
    raise exception 'sort is one of name, createdAt' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'name', x."name",
    'slug', x."slug",
    'description', x."description",
    'status', x."status",
    'member_ids', coalesce((
      select jsonb_agg(m."user_id" order by m."created_at")
      from "better_supabase"."team_members" m
      where m."team_id" = x."id"
    ), '[]'::jsonb)
  ) as j, jsonb_build_array((lower(x."name"))::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
        and (v_after is null or (lower(x."name"), x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by lower(x."name") asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'name', x."name",
    'slug', x."slug",
    'description', x."description",
    'status', x."status",
    'member_ids', coalesce((
      select jsonb_agg(m."user_id" order by m."created_at")
      from "better_supabase"."team_members" m
      where m."team_id" = x."id"
    ), '[]'::jsonb)
  ) as j, jsonb_build_array((lower(x."name"))::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
        and (v_after is null or (lower(x."name") <= (v_after ->> 0)::text and ((lower(x."name") < (v_after ->> 0)::text) or (lower(x."name") = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by lower(x."name") desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'name', x."name",
    'slug', x."slug",
    'description', x."description",
    'status', x."status",
    'member_ids', coalesce((
      select jsonb_agg(m."user_id" order by m."created_at")
      from "better_supabase"."team_members" m
      where m."team_id" = x."id"
    ), '[]'::jsonb)
  ) as j, jsonb_build_array((lower(x."name"))::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
        and (v_after is null or (lower(x."name"), x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by lower(x."name") asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'name', x."name",
    'slug', x."slug",
    'description', x."description",
    'status', x."status",
    'member_ids', coalesce((
      select jsonb_agg(m."user_id" order by m."created_at")
      from "better_supabase"."team_members" m
      where m."team_id" = x."id"
    ), '[]'::jsonb)
  ) as j, jsonb_build_array((lower(x."name"))::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
        and (v_after is null or (lower(x."name") <= (v_after ->> 0)::text and ((lower(x."name") < (v_after ->> 0)::text) or (lower(x."name") = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by lower(x."name") desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'name', x."name",
    'slug', x."slug",
    'description', x."description",
    'status', x."status",
    'member_ids', coalesce((
      select jsonb_agg(m."user_id" order by m."created_at")
      from "better_supabase"."team_members" m
      where m."team_id" = x."id"
    ), '[]'::jsonb)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'name', x."name",
    'slug', x."slug",
    'description', x."description",
    'status', x."status",
    'member_ids', coalesce((
      select jsonb_agg(m."user_id" order by m."created_at")
      from "better_supabase"."team_members" m
      where m."team_id" = x."id"
    ), '[]'::jsonb)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."teams" x
      where x."tenant_id" = list_teams.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."slug" ilike v_search or coalesce(x."description", '') ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.maintenance (
  job_name  text    DEFAULT NULL::text,
  force_run boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_job record;
  v_result jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('better_supabase.maintenance')) then
    return v_out;
  end if;
  for v_job in
    select j.job, j.function from "better_supabase"."maintenance_jobs" j
    where (maintenance.job_name is null and (maintenance.force_run or j.due)) or j.job = maintenance.job_name
    order by j.job
  loop
    begin
      execute pg_catalog.format('select pg_catalog.to_jsonb(%s())', v_job.function) into v_result;
      insert into "better_supabase"."maintenance_state" ("job", "last_run_at", "last_status", "last_result", "last_error", "runs")
      values (v_job.job, now(), 'ok', v_result, null, 1)
      on conflict ("job") do update set "last_run_at" = now(), "last_status" = 'ok',
        "last_result" = excluded."last_result", "last_error" = null, "runs" = "better_supabase"."maintenance_state"."runs" + 1;
      v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('job', v_job.job, 'status', 'ok', 'result', v_result));
    exception when others then
      insert into "better_supabase"."maintenance_state" ("job", "last_run_at", "last_status", "last_result", "last_error", "runs")
      values (v_job.job, now(), 'error', null, sqlerrm, 1)
      on conflict ("job") do update set "last_run_at" = now(), "last_status" = 'error',
        "last_result" = null, "last_error" = excluded."last_error", "runs" = "better_supabase"."maintenance_state"."runs" + 1;
      v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('job', v_job.job, 'status', 'error', 'error', sqlerrm));
    end;
  end loop;
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.maintenance_schedule (
  cron_schedule text DEFAULT '*/5 * * * *'::text
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_schedule regprocedure := pg_catalog.to_regprocedure('cron.schedule(text, text, text)');
begin
  if v_schedule is null then
    return 'none';
  end if;
  execute pg_catalog.format('select cron.schedule(%L, %L, %L)', 'better-supabase-maintenance', maintenance_schedule.cron_schedule, 'select "better_supabase"."maintenance"()');
  return 'pg_cron';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.maintenance_scheduler()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_jobs regclass := pg_catalog.to_regclass('cron.job');
  v_found boolean := false;
begin
  if v_jobs is not null then
    execute pg_catalog.format('select exists (select 1 from %s where jobname = ''better-supabase-maintenance'')', v_jobs) into v_found;
  end if;
  return case when v_found then 'pg_cron' else 'none' end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.mark_usage_reported (
  tenant uuid,
  meter  text,
  day    date,
  value  numeric
)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  with updated as (
    update "better_supabase"."usage_counters" c set "reported_value" = greatest(c."reported_value", mark_usage_reported.value)
    where c."tenant_id" = mark_usage_reported.tenant
      and c."meter" = mark_usage_reported.meter
      and c."day" = mark_usage_reported.day
    returning 1
  )
  select exists (select 1 from updated)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.mark_used (
  organization uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
begin
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.matching_rules (
  tenant       uuid,
  subject_type text,
  trigger      text,
  subject      jsonb,
  time_zone    text  DEFAULT 'UTC'::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_fields jsonb;
  v_rule "better_supabase"."automations";
  v_result jsonb;
  v_matches jsonb := '[]'::jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', matching_rules.tenant, 'automations.read'), false)) then
    raise exception 'You may not read this organization''s rules' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  v_fields := "better_supabase"."rule_field_map"(matching_rules.subject_type);
  for v_rule in
    select * from "better_supabase"."automations" x
    where x."tenant_id" = matching_rules.tenant and x."subject_type" = matching_rules.subject_type
      and x."trigger" = matching_rules.trigger and x."enabled"
    order by x."rank" collate "C"
  loop
    v_result := "better_supabase"."rule_evaluate"(v_rule."conditions", matching_rules.subject, v_fields, coalesce(matching_rules.time_zone, 'UTC'), now());
    if (v_result ->> 'matched')::boolean then
      v_matches := v_matches || jsonb_build_array(jsonb_build_object('rule', jsonb_build_object('id', v_rule."id", 'organizationId', v_rule."tenant_id", 'subjectType', v_rule."subject_type", 'trigger', v_rule."trigger", 'name', v_rule."name", 'description', v_rule."description", 'conditions', v_rule."conditions", 'actions', v_rule."actions", 'enabled', v_rule."enabled", 'stopProcessing', v_rule."stop_processing", 'rank', v_rule."rank", 'version', v_rule."version", 'createdBy', v_rule."created_by", 'updatedBy', v_rule."updated_by", 'createdAt', v_rule."created_at", 'updatedAt', v_rule."updated_at", 'defaultKey', v_rule."default_key"), 'results', v_result -> 'results'));
      exit when v_rule."stop_processing";
    end if;
  end loop;
  return v_matches;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.member_permissions (
  member uuid,
  tenant uuid
)
  RETURNS text[]
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select case
    when member is not null
      and not better_supabase.user_disabled(member)
      and not better_supabase.tenant_disabled(tenant)
    then coalesce(array(select k from unnest(coalesce((array(select permdock.permitted_organization_permission_keys_for(member, tenant))), '{}'::text[])) as k where k = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.read', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])), '{}'::text[])
    else '{}'::text[]
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.my_invitations()
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  invitee_email text;
  result jsonb := '[]'::jsonb;
begin
  select lower(u.email) into invitee_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
  if invitee_email is null then
    return result;
  end if;
  select coalesce(jsonb_agg(x.invitation order by x.expires_at), '[]'::jsonb)
  into result
  from (
    select (jsonb_build_object(
    'id', i."id",
    'tenant', i."tenant_id",
    'email', i."email",
    'role', i."role",
    'expires_at', i."expires_at",
    'created_at', i."created_at",
    'invited_by', i."invited_by",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = i."tenant_id"),
    'prefill', '{}'::jsonb,
    'token', null
  ) || "better_supabase"."invitation_extra"(i."id")) - 'token' as invitation, i."id" as id, i."expires_at" as expires_at
    from "better_supabase"."invitations" i
    where lower(i."email") = invitee_email
      and i."expires_at" >= now() and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  ) x;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.note_ssf_verification (
  stream_id    uuid,
  min_interval interval
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_noted boolean;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  if not exists (select 1 from "better_supabase"."ssf_streams" s where s."id" = note_ssf_verification.stream_id) then
    raise exception 'stream not found' using errcode = 'P0002', hint = 'SECURITY_EVENT_STREAM_NOT_FOUND';
  end if;
  update "better_supabase"."ssf_streams" s set "verified_at" = now()
  where s."id" = note_ssf_verification.stream_id
    and (s."verified_at" is null or s."verified_at" + coalesce(note_ssf_verification.min_interval, '0 seconds') <= now())
  returning true into v_noted;
  return coalesce(v_noted, false);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.open_approval (
  tenant       uuid,
  subject_type text,
  subject_id   text,
  action       text,
  policy       jsonb,
  reason       text,
  payload      jsonb,
  requested_by uuid    DEFAULT NULL::uuid,
  on_behalf    boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_policy jsonb := open_approval.policy;
  v_requester uuid := case when open_approval.on_behalf then open_approval.requested_by else coalesce(open_approval.requested_by, auth.uid()) end;
begin
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_request"(uuid, text, text, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text, $3::text, $4::text)', v_hook::oid::regproc)
        using open_approval.tenant, open_approval.subject_type, open_approval.subject_id, open_approval.action;
    end if;
  end;
  if exists (select 1 from jsonb_array_elements(coalesce(v_policy -> 'steps', '[]'::jsonb)) e where e.value -> 'required' = '"all"'::jsonb) then
    v_policy := jsonb_set(v_policy, '{steps}', (
      select jsonb_agg(case when e.value -> 'required' = '"all"'::jsonb
        then e.value || jsonb_build_object('approvers', jsonb_build_object('users', h.users), 'required', jsonb_array_length(h.users), 'all', true, 'permission', e.value -> 'approvers' ->> 'permission')
        else e.value end order by e.ordinality)
      from jsonb_array_elements(v_policy -> 'steps') with ordinality e
      left join lateral (
        select coalesce(jsonb_agg(distinct to_jsonb(u.id::text)), '[]'::jsonb) as users
        from (select h.u from permdock.permitted_organization_users((e.value -> 'approvers' ->> 'permission'), open_approval.tenant) as h(u)) as u(id)
        where u.id is not null and (u.id is distinct from v_requester or coalesce((v_policy ->> 'selfApproval')::boolean, false))
          and not (coalesce(v_policy -> 'excludedUserIds', '[]'::jsonb) ? u.id::text)
      ) h on e.value -> 'required' = '"all"'::jsonb
    ));
    if exists (select 1 from jsonb_array_elements(v_policy -> 'steps') e where e.value -> 'required' = '0'::jsonb) then
      raise exception 'nobody holds the permission a step asks every holder of' using errcode = '22023', hint = 'APPROVAL_APPROVERS_EMPTY';
    end if;
  end if;
  insert into "better_supabase"."approval_requests" ("tenant_id", "subject_type", "subject_id", "action", "policy", "requested_by", "reason", "payload", "expires_at")
  values (open_approval.tenant, open_approval.subject_type, open_approval.subject_id, open_approval.action, v_policy, v_requester, open_approval.reason, coalesce(open_approval.payload, '{}'::jsonb),
    case when open_approval.policy ->> 'expiresIn' is not null then now() + (open_approval.policy ->> 'expiresIn')::interval end)
  on conflict ("subject_type", "subject_id", "action") where "status" = 'pending' do nothing
  returning * into v_req;
  if not found then
    raise exception 'this record already has a pending request for that action' using errcode = '23505', hint = 'APPROVAL_PENDING';
  end if;
  perform better_supabase.audit_event(
    event_type => 'approval.requested',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'requested' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
  perform "better_supabase"."approval_notify"(v_req."id", 'requested');
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_request"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_req."id";
    end if;
  end;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.operation_permission (
  op text
)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case op
    when 'access-requests.create' then 'access_requests.create'
    when 'access-requests.emergency' then 'access_requests.emergency'
    when 'access-requests.manage' then 'access_requests.manage'
    when 'access-requests.read' then 'access_requests.read'
    when 'access-requests.review' then 'access_requests.review'
    when 'api-keys.manage' then 'api_keys.manage'
    when 'api-keys.own' then 'api_keys.own'
    when 'approvals.manage' then 'approvals.manage'
    when 'approvals.read' then 'approvals.read'
    when 'approvals.request' then 'approvals.request'
    when 'audit.read' then 'audit.read'
    when 'audit.readAll' then 'audit.read'
    when 'audit.revert' then 'audit.revert'
    when 'automations.manage' then 'automations.manage'
    when 'automations.publish' then 'automations.publish'
    when 'automations.read' then 'automations.read'
    when 'automations.write' then 'automations.write'
    when 'impersonation.read' then 'impersonation.read'
    when 'impersonation.revoke' then 'impersonation.revoke'
    when 'impersonation.start' then 'impersonation.start'
    when 'invitations.invite' then 'members.invite'
    when 'invitations.invitePlatform' then 'platform.invite'
    when 'invitations.read' then 'members.invite'
    when 'invitations.revoke' then 'members.invite'
    when 'organizations.delete' then 'organization.delete'
    when 'organizations.listMembers' then 'members.read'
    when 'organizations.removeMember' then 'members.remove'
    when 'organizations.suspendMember' then 'members.remove'
    when 'organizations.transferOwnership' then 'organization.transfer_ownership'
    when 'organizations.update' then 'organization.update'
    when 'organizations.updateRole' then 'members.update_role'
    when 'permissions.explain' then 'members.read'
    when 'permissions.listRoles' then 'members.read'
    when 'permissions.setOverride' then 'roles.manage'
    when 'relations.manage' then 'relations.manage'
    when 'relations.read' then 'relations.read'
    when 'service-accounts.manage' then 'service_accounts.manage'
    when 'service-accounts.read' then 'service_accounts.read'
    when 'settings.platform' then 'settings.manage'
    when 'settings.read' then 'settings.read'
    when 'settings.update' then 'settings.update'
    when 'share-links.create' then 'quotes.update'
    when 'share-links.read' then 'quotes.read'
    when 'sso.manage' then 'sso.manage'
    when 'teams.manage' then 'teams.manage'
    when 'teams.read' then 'teams.read'
    when 'usage.read' then 'usage.read'
    when 'usage.record' then 'usage.record'
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.organization_domain (
  id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."sso_domains";
begin
  select * into v_row from "better_supabase"."sso_domains" x where x."id" = organization_domain.id;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'sso.manage'), false)) then
    return null;
  end if;
  return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.organization_overview (
  organization uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_org jsonb;
  v_seats integer;
begin
  select to_jsonb(o) into v_org
  from "better_supabase"."list_my_organizations"() o
  where o.id = organization_overview.organization;
  if v_org is null then
    raise exception 'Not a member of this organization' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  
  return jsonb_build_object(
    'id', v_org ->> 'id',
    'name', v_org ->> 'name',
    'slug', v_org -> 'slug',
    'role', v_org ->> 'role',
    'seats', v_seats,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', m.user_id, 'role', m.role,
        'roles', coalesce(to_jsonb(m) -> 'roles', jsonb_build_array(m.role)),
        'disabledAt', to_jsonb(m) -> 'disabled_at')
        order by m.user_id)
      from "better_supabase"."list_members"(organization_overview.organization) m
    ), '[]'::jsonb),
    'invitations', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', i.id, 'email', i.email, 'role', i.role, 'expiresAt', to_jsonb(i) -> 'expires_at')
          order by i.email)
        from "better_supabase"."list_organization_invitations"(organization_overview.organization) i
      ), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.organization_profile_updated_at (
  subject_id text
)
  RETURNS timestamp WITH time zone
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select x."updated_at" from "better_supabase"."organization_profiles" x where x."tenant_id"::text = organization_profile_updated_at.subject_id
$function$;

CREATE OR REPLACE FUNCTION better_supabase.organization_setting (
  tenant uuid,
  key    text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select s."value"
  from "better_supabase"."organization_settings" s
  where s."tenant_id" = organization_setting.tenant and s."key" = organization_setting.key
$function$;

CREATE OR REPLACE FUNCTION better_supabase.organization_slug_problem (
  value               text,
  except_organization uuid DEFAULT NULL::uuid
)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select case
    when value is null then null
    when length(value) < 2 or length(value) > 48 or value !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' then 'invalid'
    when false then 'reserved'
    when exists (
      select 1 from "better_supabase"."organizations" o
      where lower(o."slug"::text) = lower(value) and o."deleted_at" is null
        and o."id" is distinct from except_organization
    ) then 'taken'
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_api_keys (
  tenant  uuid  DEFAULT NULL::uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_api_keys.filters, '{}'::jsonb);
  v_search text := case when nullif(trim(v_filters ->> 'search'), '') is null then null
    else '%' || replace(replace(replace(trim(v_filters ->> 'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('revoked') then
      raise exception 'facet is one of revoked' using errcode = '22023', hint = 'API_KEY_INVALID';
    end if;
    with s as (
      select (case v_facet when 'revoked' then ((x."revoked_at" is not null)::text)::text end) as v
      from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('createdAt', 'name', 'expiresAt', 'lastUsedAt') then
    raise exception 'sort is one of createdAt, name, expiresAt, lastUsedAt' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."name", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."name" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."name" <= (v_after ->> 0)::text and ((x."name" < (v_after ->> 0)::text) or (x."name" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."name" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."expires_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."expires_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."expires_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."expires_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."expires_at" <= (v_after ->> 0)::timestamptz and ((x."expires_at" < (v_after ->> 0)::timestamptz) or (x."expires_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."expires_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'lastUsedAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."last_used_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."last_used_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."last_used_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'lastUsedAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'API_KEY_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', x."id",
    'organization_id', x."tenant_id",
    'user_id', x."user_id",
    'name', x."name",
    'prefix', x."prefix",
    'public_id', x."public_id",
    'scopes', to_jsonb(x."scopes"),
    'kind', x."kind",
    'rate_limit', x."rate_limit",
    'expires_at', x."expires_at",
    'last_used_at', x."last_used_at",
    'revoked_at', x."revoked_at",
    'rotated_from', x."rotated_from",
    'created_by', x."created_by",
    'created_at', x."created_at",
    'state', case
      when x."revoked_at" is not null and x."revoked_at" <= now() then 'revoked'
      when x."expires_at" is not null and x."expires_at" <= now() then 'expired'
      when x."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = x."id" order by s."created_at" desc limit 1)
  ) as j, jsonb_build_array((x."last_used_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
        and (v_after is null or (x."last_used_at" <= (v_after ->> 0)::timestamptz and ((x."last_used_at" < (v_after ->> 0)::timestamptz) or (x."last_used_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."last_used_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."api_keys" x
      where (case when page_api_keys.tenant is null then x."user_id" = auth.uid() else x."tenant_id" = page_api_keys.tenant and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_api_keys.tenant, 'api_keys.manage'), false) or x."user_id" = auth.uid()) end)
        and (not (v_filters -> 'userId' is not null and jsonb_typeof(v_filters -> 'userId') <> 'null' and not (jsonb_typeof(v_filters -> 'userId') = 'array' and jsonb_array_length(v_filters -> 'userId') = 0)) or x."user_id"::text = any((case when jsonb_typeof(v_filters -> 'userId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'userId')) else array[v_filters ->> 'userId'] end)::text[]))
        and (not (v_filters -> 'revoked' is not null and jsonb_typeof(v_filters -> 'revoked') <> 'null' and not (jsonb_typeof(v_filters -> 'revoked') = 'array' and jsonb_array_length(v_filters -> 'revoked') = 0)) or (x."revoked_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'revoked') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'revoked')) else array[v_filters ->> 'revoked'] end)::text[]))
        and (v_search is null or x."name" ilike v_search or x."prefix" ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_approvals (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_approvals.filters, '{}'::jsonb);
  v_read boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', page_approvals.tenant, 'approvals.read'), false);
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'filters must be an object' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('status', 'subjectType') then
      raise exception 'facet is one of status, subjectType' using errcode = '22023', hint = 'APPROVAL_INVALID';
    end if;
    with s as (
      select (case v_facet when 'status' then (x."status")::text when 'subjectType' then (x."subject_type")::text end) as v
      from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('createdAt', 'action') then
    raise exception 'sort is one of createdAt, action' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at") as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."created_at" >= (v_after ->> 0)::timestamptz and ((x."created_at" > (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" < (v_after ->> 1)::uuid))))
      order by x."created_at" asc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at") as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."created_at", x."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" desc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at") as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."created_at" >= (v_after ->> 0)::timestamptz and ((x."created_at" > (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" < (v_after ->> 1)::uuid))))
      order by x."created_at" asc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at") as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."created_at", x."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" desc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'action' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at") as j, jsonb_build_array((x."action")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."action" >= (v_after ->> 0)::text and ((x."action" > (v_after ->> 0)::text) or (x."action" = (v_after ->> 0)::text and x."id" < (v_after ->> 1)::uuid))))
      order by x."action" asc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'action' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'APPROVAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'subjectId', x."subject_id", 'action', x."action", 'status', x."status", 'step', x."step", 'steps', x."policy" -> 'steps', 'requestedBy', x."requested_by", 'reason', x."reason", 'payload', x."payload", 'expiresAt', x."expires_at", 'decidedAt', x."decided_at", 'mode', coalesce(x."policy" ->> 'mode', 'authorize'), 'fingerprint', x."fingerprint", 'consumedAt', x."consumed_at", 'createdAt', x."created_at") as j, jsonb_build_array((x."action")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
        and (v_after is null or (x."action", x."id") < ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."action" desc, x."id" desc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."approval_requests" x
      where x."tenant_id" = page_approvals.tenant
        and (not (v_filters -> 'status' is not null and jsonb_typeof(v_filters -> 'status') <> 'null' and not (jsonb_typeof(v_filters -> 'status') = 'array' and jsonb_array_length(v_filters -> 'status') = 0)) or (x."status")::text = any((case when jsonb_typeof(v_filters -> 'status') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'status')) else array[v_filters ->> 'status'] end)::text[]))
        and (not (v_filters -> 'subjectType' is not null and jsonb_typeof(v_filters -> 'subjectType') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectType') = 'array' and jsonb_array_length(v_filters -> 'subjectType') = 0)) or (x."subject_type")::text = any((case when jsonb_typeof(v_filters -> 'subjectType') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectType')) else array[v_filters ->> 'subjectType'] end)::text[]))
        and (not (v_filters -> 'subjectId' is not null and jsonb_typeof(v_filters -> 'subjectId') <> 'null' and not (jsonb_typeof(v_filters -> 'subjectId') = 'array' and jsonb_array_length(v_filters -> 'subjectId') = 0)) or (x."subject_id")::text = any((case when jsonb_typeof(v_filters -> 'subjectId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'subjectId')) else array[v_filters ->> 'subjectId'] end)::text[]))
        and (not (v_filters -> 'action' is not null and jsonb_typeof(v_filters -> 'action') <> 'null' and not (jsonb_typeof(v_filters -> 'action') = 'array' and jsonb_array_length(v_filters -> 'action') = 0)) or (x."action")::text = any((case when jsonb_typeof(v_filters -> 'action') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'action')) else array[v_filters ->> 'action'] end)::text[]))
        and case when coalesce(nullif(coalesce(v_filters #>> '{assigned,0}', v_filters ->> 'assigned'), '') = 'true', false) then x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant))
        else x."requested_by" = auth.uid() or (v_read and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (not x."subject_type" in ('support_request') and (x."subject_type" = 'access_request' or true)))) or x."id" in (select "better_supabase"."approval_eligible_ids"(page_approvals.tenant)) end
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_organization_domains (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_organization_domains.filters, '{}'::jsonb);
  v_search text := case when nullif(trim(v_filters ->> 'search'), '') is null then null
    else '%' || replace(replace(replace(trim(v_filters ->> 'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.can('tenant', page_organization_domains.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s domains' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('verified', 'enforceSso') then
      raise exception 'facet is one of verified, enforceSso' using errcode = '22023', hint = 'SSO_INVALID';
    end if;
    with s as (
      select (case v_facet when 'verified' then ((x."verified_at" is not null)::text)::text when 'enforceSso' then (x."enforce_sso"::text)::text end) as v
      from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('domain', 'verifiedAt') then
    raise exception 'sort is one of domain, verifiedAt' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."domain")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."domain", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."domain" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."domain")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."domain" <= (v_after ->> 0)::text and ((x."domain" < (v_after ->> 0)::text) or (x."domain" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."domain" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'domain' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."domain")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."domain", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."domain" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'domain' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."domain")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."domain" <= (v_after ->> 0)::text and ((x."domain" < (v_after ->> 0)::text) or (x."domain" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."domain" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'verifiedAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."verified_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."verified_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."verified_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'verifiedAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || x."domain", 'value', 'better-supabase-domain-verification=' || x."verification_token")) as j, jsonb_build_array((x."verified_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
        and (v_after is null or (x."verified_at" <= (v_after ->> 0)::timestamptz and ((x."verified_at" < (v_after ->> 0)::timestamptz) or (x."verified_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."verified_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."sso_domains" x
      where x."tenant_id" = page_organization_domains.tenant
        and (not (v_filters -> 'verified' is not null and jsonb_typeof(v_filters -> 'verified') <> 'null' and not (jsonb_typeof(v_filters -> 'verified') = 'array' and jsonb_array_length(v_filters -> 'verified') = 0)) or (x."verified_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'verified') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'verified')) else array[v_filters ->> 'verified'] end)::text[]))
        and (not (v_filters -> 'enforceSso' is not null and jsonb_typeof(v_filters -> 'enforceSso') <> 'null' and not (jsonb_typeof(v_filters -> 'enforceSso') = 'array' and jsonb_array_length(v_filters -> 'enforceSso') = 0)) or x."enforce_sso"::text = any((case when jsonb_typeof(v_filters -> 'enforceSso') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'enforceSso')) else array[v_filters ->> 'enforceSso'] end)::text[]))
        and (not (v_filters -> 'autoJoinRole' is not null and jsonb_typeof(v_filters -> 'autoJoinRole') <> 'null' and not (jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' and jsonb_array_length(v_filters -> 'autoJoinRole') = 0)) or x."auto_join_role"::text = any((case when jsonb_typeof(v_filters -> 'autoJoinRole') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'autoJoinRole')) else array[v_filters ->> 'autoJoinRole'] end)::text[]))
        and (v_search is null or x."domain" ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_organization_invitations (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_organization_invitations.filters, '{}'::jsonb);
  v_search text := case when nullif(trim(v_filters ->> 'search'), '') is null then null
    else '%' || replace(replace(replace(trim(v_filters ->> 'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if not coalesce(better_supabase.member_can((select auth.uid()), tenant, 'members.invite'), false) then
    raise exception 'Not allowed to list invitations' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('role') then
      raise exception 'facet is one of role' using errcode = '22023', hint = 'INVITATION_INVALID';
    end if;
    with s as (
      select (case v_facet when 'role' then (i."role"::text)::text end) as v
      from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('expiresAt', 'email') then
    raise exception 'sort is one of expiresAt, email' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((coalesce(i."expires_at", 'infinity'::timestamptz))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (coalesce(i."expires_at", 'infinity'::timestamptz) >= (v_after ->> 0)::timestamptz and ((coalesce(i."expires_at", 'infinity'::timestamptz) > (v_after ->> 0)::timestamptz) or (coalesce(i."expires_at", 'infinity'::timestamptz) = (v_after ->> 0)::timestamptz and i."id" < (v_after ->> 1)::uuid))))
      order by coalesce(i."expires_at", 'infinity'::timestamptz) asc, i."id" desc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((coalesce(i."expires_at", 'infinity'::timestamptz))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (coalesce(i."expires_at", 'infinity'::timestamptz), i."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by coalesce(i."expires_at", 'infinity'::timestamptz) desc, i."id" desc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((coalesce(i."expires_at", 'infinity'::timestamptz))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (coalesce(i."expires_at", 'infinity'::timestamptz) >= (v_after ->> 0)::timestamptz and ((coalesce(i."expires_at", 'infinity'::timestamptz) > (v_after ->> 0)::timestamptz) or (coalesce(i."expires_at", 'infinity'::timestamptz) = (v_after ->> 0)::timestamptz and i."id" < (v_after ->> 1)::uuid))))
      order by coalesce(i."expires_at", 'infinity'::timestamptz) asc, i."id" desc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((coalesce(i."expires_at", 'infinity'::timestamptz))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (coalesce(i."expires_at", 'infinity'::timestamptz), i."id") < ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by coalesce(i."expires_at", 'infinity'::timestamptz) desc, i."id" desc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort = 'email' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((lower(i."email"))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (lower(i."email"), i."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by lower(i."email") asc, i."id" asc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  elsif v_sort = 'email' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'INVITATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('id', i."id", 'email', i."email", 'role', i."role"::text, 'expiresAt', i."expires_at") as j, jsonb_build_array((lower(i."email"))::text, (i."id")::text) as k
    from (
      select * from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
        and (v_after is null or (lower(i."email") <= (v_after ->> 0)::text and ((lower(i."email") < (v_after ->> 0)::text) or (lower(i."email") = (v_after ->> 0)::text and i."id" > (v_after ->> 1)::uuid))))
      order by lower(i."email") desc, i."id" asc
      limit v_limit + 1 offset v_offset
    ) i
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."invitations" i
      where i."tenant_id" = page_organization_invitations.tenant
        and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
        and i."expires_at" >= now()
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or i."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_search is null or i."email" ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_organization_members (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_organization_members.filters, '{}'::jsonb);
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if not coalesce(better_supabase.member_can((select auth.uid()), tenant, 'members.read'), false) then
    raise exception 'Not allowed to list members' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('role') then
      raise exception 'facet is one of role' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
    end if;
    with s as (
      select (case v_facet when 'role' then (m."role"::text)::text end) as v
      from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('role', 'userId') then
    raise exception 'sort is one of role, userId' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."role"::text)::text, (m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."role"::text, m."user_id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by m."role"::text asc, m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."role"::text)::text, (m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."role"::text <= (v_after ->> 0)::text and ((m."role"::text < (v_after ->> 0)::text) or (m."role"::text = (v_after ->> 0)::text and m."user_id" > (v_after ->> 1)::uuid))))
      order by m."role"::text desc, m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort = 'role' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."role"::text)::text, (m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."role"::text, m."user_id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by m."role"::text asc, m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort = 'role' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."role"::text)::text, (m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."role"::text <= (v_after ->> 0)::text and ((m."role"::text < (v_after ->> 0)::text) or (m."role"::text = (v_after ->> 0)::text and m."user_id" > (v_after ->> 1)::uuid))))
      order by m."role"::text desc, m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort = 'userId' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 1) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."user_id") > ((v_after ->> 0)::uuid))
      order by m."user_id" asc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  elsif v_sort = 'userId' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 1) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'ORGANIZATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object('user_id', m."user_id", 'role', m."role"::text) as j, jsonb_build_array((m."user_id")::text) as k
    from (
      select * from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (v_after is null or (m."user_id") < ((v_after ->> 0)::uuid))
      order by m."user_id" desc
      limit v_limit + 1 offset v_offset
    ) m
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "public"."organization_memberships" m
      where m."organization_id" = page_organization_members.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or m."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_service_principals (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_service_principals.filters, '{}'::jsonb);
  v_search text := case when nullif(trim(v_filters ->> 'search'), '') is null then null
    else '%' || replace(replace(replace(trim(v_filters ->> 'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('role', 'isDefault', 'disabled') then
      raise exception 'facet is one of role, isDefault, disabled' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
    end if;
    with s as (
      select (case v_facet when 'role' then (x."role"::text)::text when 'isDefault' then (x."is_default"::text)::text when 'disabled' then ((x."disabled_at" is not null)::text)::text end) as v
      from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('name', 'createdAt') then
    raise exception 'sort is one of name, createdAt' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."name", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."name" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."name" <= (v_after ->> 0)::text and ((x."name" < (v_after ->> 0)::text) or (x."name" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."name" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."name", x."id") > ((v_after ->> 0)::text, (v_after ->> 1)::uuid))
      order by x."name" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'name' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."name")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."name" <= (v_after ->> 0)::text and ((x."name" < (v_after ->> 0)::text) or (x."name" = (v_after ->> 0)::text and x."id" > (v_after ->> 1)::uuid))))
      order by x."name" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
      'id', x."id", 'name', x."name", 'role', x."role", 'isDefault', x."is_default",
      'createdBy', x."created_by", 'createdAt', x."created_at", 'disabledAt', x."disabled_at"
    ) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."service_principals" x
      where x."tenant_id" = page_service_principals.tenant
        and (not (v_filters -> 'role' is not null and jsonb_typeof(v_filters -> 'role') <> 'null' and not (jsonb_typeof(v_filters -> 'role') = 'array' and jsonb_array_length(v_filters -> 'role') = 0)) or x."role"::text = any((case when jsonb_typeof(v_filters -> 'role') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'role')) else array[v_filters ->> 'role'] end)::text[]))
        and (not (v_filters -> 'isDefault' is not null and jsonb_typeof(v_filters -> 'isDefault') <> 'null' and not (jsonb_typeof(v_filters -> 'isDefault') = 'array' and jsonb_array_length(v_filters -> 'isDefault') = 0)) or x."is_default"::text = any((case when jsonb_typeof(v_filters -> 'isDefault') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'isDefault')) else array[v_filters ->> 'isDefault'] end)::text[]))
        and (not (v_filters -> 'disabled' is not null and jsonb_typeof(v_filters -> 'disabled') <> 'null' and not (jsonb_typeof(v_filters -> 'disabled') = 'array' and jsonb_array_length(v_filters -> 'disabled') = 0)) or (x."disabled_at" is not null)::text = any((case when jsonb_typeof(v_filters -> 'disabled') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'disabled')) else array[v_filters ->> 'disabled'] end)::text[]))
        and (v_search is null or x."name" ilike v_search)
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_sso_providers (
  tenant  uuid,
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_sso_providers.filters, '{}'::jsonb);
  v_search text := case when nullif(trim(v_filters ->> 'search'), '') is null then null
    else '%' || replace(replace(replace(trim(v_filters ->> 'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.can('tenant', page_sso_providers.tenant, 'sso.manage'), false) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('type') then
      raise exception 'facet is one of type' using errcode = '22023', hint = 'SSO_INVALID';
    end if;
    with s as (
      select (case v_facet when 'type' then (x."type"::text)::text end) as v
      from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('createdAt') then
    raise exception 'sort is one of createdAt' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x.*) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x.*) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'asc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x.*) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
        and (v_after is null or (x."created_at", x."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by x."created_at" asc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  elsif v_sort = 'createdAt' and coalesce(v_dir, 'asc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'SSO_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, to_jsonb(x.*) as j, jsonb_build_array((x."created_at")::text, (x."id")::text) as k
    from (
      select * from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
        and (v_after is null or (x."created_at" <= (v_after ->> 0)::timestamptz and ((x."created_at" < (v_after ->> 0)::timestamptz) or (x."created_at" = (v_after ->> 0)::timestamptz and x."id" > (v_after ->> 1)::uuid))))
      order by x."created_at" desc, x."id" asc
      limit v_limit + 1 offset v_offset
    ) x
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."sso_providers" x
      where x."tenant_id" = page_sso_providers.tenant
        and (not (v_filters -> 'type' is not null and jsonb_typeof(v_filters -> 'type') <> 'null' and not (jsonb_typeof(v_filters -> 'type') = 'array' and jsonb_array_length(v_filters -> 'type') = 0)) or x."type"::text = any((case when jsonb_typeof(v_filters -> 'type') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'type')) else array[v_filters ->> 'type'] end)::text[]))
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.page_support_sessions (
  filters jsonb DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_filters jsonb := coalesce(page_support_sessions.filters, '{}'::jsonb);
  v_limit integer := least(greatest(coalesce((v_filters ->> 'limit')::integer, 50), 1), 200);
  v_offset integer := greatest(coalesce((v_filters ->> 'offset')::integer, 0), 0);
  v_after jsonb := v_filters -> 'after';
  v_paged boolean := coalesce((v_filters ->> 'paged')::boolean, false);
  v_total_cap integer := least(greatest(coalesce((v_filters ->> 'totalCap')::integer, 10000), 1), 100000);
  v_items jsonb;
  v_more boolean;
  v_next jsonb;
  v_total integer;
  v_sort text := nullif(v_filters ->> 'sort', '');
  v_dir text := nullif(v_filters ->> 'direction', '');
  v_facet text := nullif(v_filters ->> 'facet', '');
  v_count boolean := coalesce((v_filters ->> 'count')::boolean, false);
  v_result jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')
      or "better_supabase"."is_platform"('impersonation.read')) then
    raise exception 'not allowed to read support sessions' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
  end if;
  if v_filters ? 'after' and v_filters ? 'offset' then
    raise exception 'after and offset are two ways to page; pass one' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  if v_facet is not null then
    if v_facet not in ('readOnly') then
      raise exception 'facet is one of readOnly' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
    end if;
    with s as (
      select (case v_facet when 'readOnly' then (s."read_only"::text)::text end) as v
      from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
      limit v_total_cap + 1
    )
    select jsonb_build_object('facet', v_facet, 'values', coalesce(jsonb_agg(jsonb_build_object('value', g.v, 'count', jsonb_build_object('value', g.n, 'exact', g.exact)) order by g.n desc, g.v), '[]'::jsonb))
    into v_result
    from (
      select s.v, count(*) as n, (select count(*) from s) <= v_total_cap as exact
      from s where s.v is not null group by s.v order by n desc, s.v limit 100
    ) g;
    return v_result;
  end if;
  if v_count then
    select count(*) into v_total from (
      select 1 from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
      limit v_total_cap + 1
    ) c;
    return jsonb_build_object('value', least(v_total, v_total_cap), 'exact', v_total <= v_total_cap);
  end if;
  if v_sort is not null and v_sort not in ('startedAt', 'expiresAt') then
    raise exception 'sort is one of startedAt, expiresAt' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  if v_dir is not null and v_dir not in ('asc', 'desc') then
    raise exception 'direction is asc or desc' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  if v_sort is null and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) as j, jsonb_build_array((s."started_at")::text, (s."id")::text) as k
    from (
      select * from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
        and (v_after is null or (s."started_at", s."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by s."started_at" asc, s."id" asc
      limit v_limit + 1 offset v_offset
    ) s
  ) p;
  elsif v_sort is null and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) as j, jsonb_build_array((s."started_at")::text, (s."id")::text) as k
    from (
      select * from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
        and (v_after is null or (s."started_at" <= (v_after ->> 0)::timestamptz and ((s."started_at" < (v_after ->> 0)::timestamptz) or (s."started_at" = (v_after ->> 0)::timestamptz and s."id" > (v_after ->> 1)::uuid))))
      order by s."started_at" desc, s."id" asc
      limit v_limit + 1 offset v_offset
    ) s
  ) p;
  elsif v_sort = 'startedAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) as j, jsonb_build_array((s."started_at")::text, (s."id")::text) as k
    from (
      select * from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
        and (v_after is null or (s."started_at", s."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by s."started_at" asc, s."id" asc
      limit v_limit + 1 offset v_offset
    ) s
  ) p;
  elsif v_sort = 'startedAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) as j, jsonb_build_array((s."started_at")::text, (s."id")::text) as k
    from (
      select * from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
        and (v_after is null or (s."started_at" <= (v_after ->> 0)::timestamptz and ((s."started_at" < (v_after ->> 0)::timestamptz) or (s."started_at" = (v_after ->> 0)::timestamptz and s."id" > (v_after ->> 1)::uuid))))
      order by s."started_at" desc, s."id" asc
      limit v_limit + 1 offset v_offset
    ) s
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'desc') = 'asc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) as j, jsonb_build_array((s."expires_at")::text, (s."id")::text) as k
    from (
      select * from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
        and (v_after is null or (s."expires_at", s."id") > ((v_after ->> 0)::timestamptz, (v_after ->> 1)::uuid))
      order by s."expires_at" asc, s."id" asc
      limit v_limit + 1 offset v_offset
    ) s
  ) p;
  elsif v_sort = 'expiresAt' and coalesce(v_dir, 'desc') = 'desc' then
    if v_after is not null and (jsonb_typeof(v_after) <> 'array' or jsonb_array_length(v_after) <> 2) then
    raise exception 'after is the nextCursor of the previous page' using errcode = '22023', hint = 'IMPERSONATION_INVALID';
  end if;
  select coalesce(jsonb_agg(p.j order by p.n) filter (where p.n <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    (array_agg(p.k order by p.n) filter (where p.n = v_limit))[1]
  into v_items, v_more, v_next
  from (
    select row_number() over () as n, jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) as j, jsonb_build_array((s."expires_at")::text, (s."id")::text) as k
    from (
      select * from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
        and (v_after is null or (s."expires_at" <= (v_after ->> 0)::timestamptz and ((s."expires_at" < (v_after ->> 0)::timestamptz) or (s."expires_at" = (v_after ->> 0)::timestamptz and s."id" > (v_after ->> 1)::uuid))))
      order by s."expires_at" desc, s."id" asc
      limit v_limit + 1 offset v_offset
    ) s
  ) p;
  end if;
  if not v_paged then
    return v_items;
  end if;
  if coalesce((v_filters ->> 'total')::boolean, false) then
    select count(*) into v_total from (
      select 1 from "better_supabase"."support_sessions" s
      where (not (v_filters -> 'adminId' is not null and jsonb_typeof(v_filters -> 'adminId') <> 'null' and not (jsonb_typeof(v_filters -> 'adminId') = 'array' and jsonb_array_length(v_filters -> 'adminId') = 0)) or s."admin_id"::text = any((case when jsonb_typeof(v_filters -> 'adminId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'adminId')) else array[v_filters ->> 'adminId'] end)::text[]))
        and (not (v_filters -> 'targetUserId' is not null and jsonb_typeof(v_filters -> 'targetUserId') <> 'null' and not (jsonb_typeof(v_filters -> 'targetUserId') = 'array' and jsonb_array_length(v_filters -> 'targetUserId') = 0)) or s."target_id"::text = any((case when jsonb_typeof(v_filters -> 'targetUserId') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'targetUserId')) else array[v_filters ->> 'targetUserId'] end)::text[]))
        and (not (v_filters -> 'tenant' is not null and jsonb_typeof(v_filters -> 'tenant') <> 'null' and not (jsonb_typeof(v_filters -> 'tenant') = 'array' and jsonb_array_length(v_filters -> 'tenant') = 0)) or s."tenant_id"::text = any((case when jsonb_typeof(v_filters -> 'tenant') = 'array' then array(select jsonb_array_elements_text(v_filters -> 'tenant')) else array[v_filters ->> 'tenant'] end)::text[]))
        and (not coalesce(nullif(coalesce(v_filters #>> '{active,0}', v_filters ->> 'active'), '') = 'true', false) or (s."ended_at" is null and s."expires_at" > now()))
      limit v_total_cap + 1
    ) c;
  end if;
  return jsonb_build_object('items', v_items, 'hasMore', v_more, 'nextCursor', case when v_more then v_next end)
    || case when v_total is null then '{}'::jsonb
      else jsonb_build_object('total', least(v_total, v_total_cap), 'totalCapped', v_total > v_total_cap) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.poll_ssf_events (
  stream_id  uuid,
  max_events integer,
  ack        text[]  DEFAULT '{}'::text[],
  errors     jsonb   DEFAULT '{}'::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."ssf_streams";
  v_limit integer := least(greatest(coalesce(poll_ssf_events.max_events, 100), 0), 1000);
  v_sets jsonb;
  v_more boolean;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."ssf_streams" s where s."id" = poll_ssf_events.stream_id;
  if not found then
    raise exception 'stream not found' using errcode = 'P0002', hint = 'SECURITY_EVENT_STREAM_NOT_FOUND';
  end if;
  if v_row."delivery_method" <> 'urn:ietf:rfc:8936' then
    raise exception 'the stream is not delivered by polling' using errcode = '22023', hint = 'SECURITY_EVENT_STREAM_NOT_POLL';
  end if;
  delete from "better_supabase"."ssf_events" q
  where q."stream_id" = v_row."id"
    and (q."jti" = any (coalesce(poll_ssf_events.ack, '{}'))
      or coalesce(poll_ssf_events.errors, '{}'::jsonb) ? q."jti");
  if v_row."status" <> 'enabled' or v_limit = 0 then
    return jsonb_build_object('sets', '{}'::jsonb, 'moreAvailable', false);
  end if;
  select count(*) > v_limit into v_more
  from (select 1 from "better_supabase"."ssf_events" q where q."stream_id" = v_row."id" limit v_limit + 1) x;
  select coalesce(jsonb_object_agg(l.jti, l.token), '{}'::jsonb) into v_sets
  from (
    select q."jti" as jti, q."token" as token from "better_supabase"."ssf_events" q
    where q."stream_id" = v_row."id"
    order by q."created_at", q."jti"
    limit v_limit
  ) l;
  return jsonb_build_object('sets', v_sets, 'moreAvailable', v_more);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_shared_signals (
  older_than interval DEFAULT NULL::interval
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_cutoff timestamptz := now() - coalesce(purge_shared_signals.older_than, '7 days'::interval);
  v_received integer;
  v_events integer;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  delete from "better_supabase"."ssf_received" x where x."received_at" < v_cutoff;
  get diagnostics v_received = row_count;
  delete from "better_supabase"."ssf_events" q where q."created_at" < v_cutoff;
  get diagnostics v_events = row_count;
  return v_received + v_events;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_team (
  team uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select "tenant_id" into v_tenant from "better_supabase"."teams" where "id" = purge_team.team;
  if not found then
    raise exception 'team not found' using errcode = 'P0002', hint = 'TEAM_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'teams.manage'), false)) then
    raise exception 'not allowed to manage teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  delete from "better_supabase"."teams" where "id" = purge_team.team;
  perform better_supabase.audit_event(
    event_type => 'team.purged',
    category => 'membership',
    target_type => 'team',
    record_id => (purge_team.team)::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant, 'id', purge_team.team)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_teams (
  team_ids uuid[]
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_team uuid;
  v_count integer := 0;
begin
  if coalesce(cardinality(purge_teams.team_ids), 0) > 1000 then
    raise exception 'purge at most 1000 teams in one call' using errcode = '22023', hint = 'TEAM_INVALID';
  end if;
  for v_team in select distinct x from unnest(purge_teams.team_ids) x where x is not null loop
    perform "better_supabase"."purge_team"(v_team);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_usage_events (
  older_than interval DEFAULT '30 days'::interval,
  batch      integer  DEFAULT 10000
)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  with gone as (
    delete from "better_supabase"."usage_events" x
    where (x."tenant_id", x."meter", x."idempotency_key") in (
      select e."tenant_id", e."meter", e."idempotency_key" from "better_supabase"."usage_events" e
      where e."recorded_at" < now() - coalesce(older_than, '30 days')
      order by e."recorded_at" limit coalesce(batch, 10000)
    )
    returning 1
  )
  select count(*)::integer from gone
$function$;

CREATE OR REPLACE FUNCTION better_supabase.purge_usage_history (
  older_than interval DEFAULT '400 days'::interval,
  batch      integer  DEFAULT 10000
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  return 0;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.queue_ssf_set (
  stream_id uuid,
  jti       text,
  token     text
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."ssf_streams";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."ssf_streams" s where s."id" = queue_ssf_set.stream_id for update;
  if not found then
    raise exception 'stream not found' using errcode = 'P0002', hint = 'SECURITY_EVENT_STREAM_NOT_FOUND';
  end if;
  if v_row."status" = 'disabled' then
    return 'dropped';
  end if;
  if v_row."delivery_method" = 'urn:ietf:rfc:8935' and v_row."status" = 'enabled' and false then
    null;
    return 'dispatched';
  end if;
  insert into "better_supabase"."ssf_events" ("stream_id", "jti", "token")
  values (v_row."id", queue_ssf_set.jti, queue_ssf_set.token)
  on conflict do nothing;
  return case when v_row."delivery_method" = 'urn:ietf:rfc:8936' and v_row."status" = 'enabled' then 'queued' else 'held' end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rank_rule (
  id   uuid,
  rank text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."automations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."automations" x where x."id" = rank_rule.id for update;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.read'), false)) then
    raise exception 'No rule you can read has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (case when v_row."enabled" then coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.publish'), false) else coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.write'), false) end)) then
    raise exception 'You need % to move this rule', case when v_row."enabled" then '''automations.publish''' else '''automations.write''' end using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if rank_rule.rank is null or rank_rule.rank !~ '^[0-9A-Za-z]*[1-9A-Za-z]$' then
    raise exception 'rank must be a key from rankBetween' using errcode = '22023', hint = 'AUTOMATION_RANK_INVALID';
  end if;
  update "better_supabase"."automations" x set "rank" = rank_rule.rank, "updated_at" = now()
  where x."id" = v_row."id" returning * into v_row;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_approval_created (
  request_id   uuid,
  item_key     text,
  created_type text,
  created_id   text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
  v_item "better_supabase"."approval_items"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = record_approval_created.request_id;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(v_req."requested_by" = auth.uid(), false) or coalesce(better_supabase.can('tenant', v_req."tenant_id", 'approvals.manage'), false)) then
    raise exception 'only the requester or a manager records what an item created' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if nullif(btrim(record_approval_created.created_type), '') is null or nullif(btrim(record_approval_created.created_id), '') is null then
    raise exception 'created_type and created_id are required' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
  end if;
  select * into v_item from "better_supabase"."approval_items" x
  where x."request_id" = v_req."id" and x."key" = record_approval_created.item_key for update;
  if not found then
    raise exception 'this request has no such item' using errcode = 'P0002', hint = 'APPROVAL_ITEM_NOT_FOUND';
  end if;
  if v_item."status" <> 'approved' then
    raise exception 'only an approved item records what it created' using errcode = '22023', hint = 'APPROVAL_ITEM_CLOSED';
  end if;
  if v_item."created_type" is not null then
    raise exception 'this item already recorded what it created' using errcode = '23505', hint = 'APPROVAL_ITEM_RECORDED';
  end if;
  update "better_supabase"."approval_items" x set "created_type" = record_approval_created.created_type, "created_id" = record_approval_created.created_id
  where x."id" = v_item."id" returning * into v_item;
  return jsonb_build_object('id', v_item."id", 'key', v_item."key", 'label', v_item."label", 'payload', v_item."payload", 'permission', v_item."permission", 'dependsOn', to_jsonb(v_item."depends_on"), 'status', v_item."status", 'createdType', v_item."created_type", 'createdId', v_item."created_id", 'decidedBy', v_item."decided_by", 'decidedAt', v_item."decided_at", 'createdAt', v_item."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_organization_setting()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."organization_settings";
begin
  if tg_op = 'DELETE' then
    v_row := old;
    perform better_supabase.audit_event(
    event_type => 'organization_setting.reset',
    category => 'configuration',
    target_type => 'setting',
    record_id => v_row."key",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'key', v_row."key")
  );
  else
    v_row := new;
    perform better_supabase.audit_event(
    event_type => 'organization_setting.updated',
    category => 'configuration',
    target_type => 'setting',
    record_id => v_row."key",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'key', v_row."key")
  );
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_platform_setting()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."platform_settings";
begin
  if tg_op = 'DELETE' then
    v_row := old;
    perform better_supabase.audit_event(
    event_type => 'platform_setting.reset',
    category => 'configuration',
    target_type => 'setting',
    record_id => v_row."key",
    metadata => jsonb_build_object('key', v_row."key")
  );
  else
    v_row := new;
    perform better_supabase.audit_event(
    event_type => 'platform_setting.updated',
    category => 'configuration',
    target_type => 'setting',
    record_id => v_row."key",
    metadata => jsonb_build_object('key', v_row."key")
  );
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_rule_evaluation (
  rule       uuid,
  subject_id text,
  matched    boolean,
  results    jsonb   DEFAULT '{}'::jsonb,
  mode       text    DEFAULT 'live'::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_rule "better_supabase"."automations";
  v_row "better_supabase"."automation_evaluations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_rule from "better_supabase"."automations" x where x."id" = record_rule_evaluation.rule;
  if v_rule."id" is null then
    raise exception 'No rule has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
  end if;
  if coalesce(record_rule_evaluation.mode, 'live') not in ('live', 'test') then
    raise exception 'mode is live or test' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if coalesce(record_rule_evaluation.mode, 'live') = 'live' and not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role records live evaluations' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_rule."tenant_id", 'automations.write'), false)) then
    raise exception 'Testing rules needs the edit permission' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  insert into "better_supabase"."automation_evaluations" ("tenant_id", "rule_id", "version", "subject_type", "subject_id", "trigger", "matched", "results", "mode", "evaluated_by")
  values (v_rule."tenant_id", v_rule."id", v_rule."version", v_rule."subject_type", record_rule_evaluation.subject_id, v_rule."trigger",
    coalesce(record_rule_evaluation.matched, false), coalesce(record_rule_evaluation.results, '{}'::jsonb), coalesce(record_rule_evaluation.mode, 'live'), auth.uid())
  returning * into v_row;
  if v_row."mode" = 'live' and v_row."matched" then
    null;
  end if;
  return jsonb_build_object('id', v_row."id"::text, 'organizationId', v_row."tenant_id", 'ruleId', v_row."rule_id", 'version', v_row."version", 'subjectType', v_row."subject_type", 'subjectId', v_row."subject_id", 'trigger', v_row."trigger", 'matched', v_row."matched", 'results', v_row."results", 'mode', v_row."mode", 'evaluatedBy', v_row."evaluated_by", 'evaluatedAt', v_row."evaluated_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_ssf_received (
  issuer text,
  jti    text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_new boolean;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  insert into "better_supabase"."ssf_received" ("issuer", "jti")
  values (record_ssf_received.issuer, record_ssf_received.jti)
  on conflict do nothing
  returning true into v_new;
  return coalesce(v_new, false);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_usage (
  tenant          uuid,
  meter           text,
  quantity        numeric DEFAULT 1,
  idempotency_key text    DEFAULT NULL::text,
  source          text    DEFAULT NULL::text,
  metadata        jsonb   DEFAULT NULL::jsonb,
  actor           uuid    DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  today date := (now() at time zone 'utc')::date;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.record'), false)) then
    raise exception 'Not allowed to record usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  if quantity is null or quantity < 0 then
    raise exception 'quantity must be zero or more' using errcode = '22023', hint = 'USAGE_QUANTITY';
  end if;
  if idempotency_key is not null then
    insert into "better_supabase"."usage_events" ("tenant_id", "meter", "idempotency_key", "quantity")
    values (tenant, meter, idempotency_key, quantity)
    on conflict do nothing;
    if not found then
      return jsonb_build_object('recorded', false, 'used', "better_supabase"."usage_used"(tenant, meter, coalesce((select q.period from "better_supabase"."usage_quota"(tenant, meter) q), 'month')), 'today', "better_supabase"."usage_used"(tenant, meter, 'day'));
    end if;
  end if;
  insert into "better_supabase"."usage_counters" as c ("tenant_id", "meter", "day", "value")
  values (tenant, meter, today, quantity)
  on conflict ("tenant_id", "meter", "day") do update
    set "value" = c."value" + excluded."value", "updated_at" = now();
  return jsonb_build_object('recorded', true, 'used', "better_supabase"."usage_used"(tenant, meter, coalesce((select q.period from "better_supabase"."usage_quota"(tenant, meter) q), 'month')), 'today', "better_supabase"."usage_used"(tenant, meter, 'day'));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.record_usage_batch (
  tenant          uuid,
  entries         jsonb,
  idempotency_key text  DEFAULT NULL::text,
  "check" boolean DEFAULT false,
  source          text  DEFAULT NULL::text,
  metadata        jsonb DEFAULT NULL::jsonb,
  actor           uuid  DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  entry jsonb;
  outcome jsonb;
  recorded boolean := false;
  used jsonb := '{}';
  today_used jsonb := '{}';
begin
  -- A JSON text of the array, as a transport that sends arrays as text passes it.
  if jsonb_typeof(entries) = 'string' then
    entries := (entries #>> '{}')::jsonb;
  end if;
  if jsonb_typeof(entries) <> 'array' or jsonb_array_length(entries) = 0 then
    raise exception 'entries must be a non-empty array of { meter, quantity }' using errcode = '22023', hint = 'USAGE_ENTRIES';
  end if;
  for entry in select value from jsonb_array_elements(entries) loop
    if jsonb_typeof(entry -> 'meter') <> 'string' then
      raise exception 'Every entry needs a meter' using errcode = '22023', hint = 'USAGE_ENTRIES';
    end if;
    if record_usage_batch."check" then
      outcome := "better_supabase"."consume_quota"(tenant, entry ->> 'meter', coalesce((entry ->> 'quantity')::numeric, 1),
        case when idempotency_key is null then null else idempotency_key || ':' || (entry ->> 'meter') end,
        source, metadata, actor);
    else
      outcome := "better_supabase"."record_usage"(tenant, entry ->> 'meter', coalesce((entry ->> 'quantity')::numeric, 1),
        case when idempotency_key is null then null else idempotency_key || ':' || (entry ->> 'meter') end,
        source, metadata, actor);
    end if;
    recorded := recorded or (outcome ->> 'recorded')::boolean;
    used := used || jsonb_build_object(entry ->> 'meter', outcome -> 'used');
    today_used := today_used || jsonb_build_object(entry ->> 'meter', outcome -> 'today');
  end loop;
  return jsonb_build_object('recorded', recorded, 'used', used, 'today', today_used);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.register_service_principal (
  principal  uuid,
  tenant     uuid,
  name       text,
  role       text,
  is_default boolean DEFAULT false,
  created_by uuid    DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Service principals are managed by the service' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  if register_service_principal.created_by is not null and not (
    coalesce(better_supabase.member_can(register_service_principal.created_by, register_service_principal.tenant, 'service_accounts.manage'), false)
    and coalesce(better_supabase.can_assign_as(register_service_principal.created_by, register_service_principal.tenant, register_service_principal.role), false)
  ) then
    raise exception 'You may not manage service principals with this role' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = register_service_principal.principal
      and coalesce((u.raw_app_meta_data ->> 'bsb_service_principal')::boolean, false)
      and u.banned_until > now() + interval '50 years'
  ) then
    raise exception 'The user is not a service principal: create it with createServiceAccounts().create' using errcode = '22023', hint = 'SERVICE_PRINCIPAL_USER';
  end if;
  if register_service_principal.is_default then
    update "better_supabase"."service_principals" set "is_default" = false
    where "tenant_id" = register_service_principal.tenant and "is_default";
  end if;
  insert into "better_supabase"."service_principals" ("id", "tenant_id", "name", "role", "is_default", "created_by")
  values (register_service_principal.principal, register_service_principal.tenant, register_service_principal.name,
    register_service_principal.role, coalesce(register_service_principal.is_default, false), register_service_principal.created_by);
  insert into "public"."organization_memberships" ("organization_id", "user_id", "role")
  values (register_service_principal.tenant, register_service_principal.principal, register_service_principal.role);
  perform better_supabase.audit_event(
    event_type => 'service_principal.created',
    category => 'access',
    target_type => 'service_principal',
    record_id => register_service_principal.principal::text,
    target_label => register_service_principal.name,
    tenant => (register_service_principal.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', register_service_principal.tenant::text, 'id', register_service_principal.principal, 'name', register_service_principal.name, 'role', register_service_principal.role),
    actor_id => coalesce(register_service_principal.created_by, auth.uid())
  );
  return jsonb_build_object('id', register_service_principal.principal, 'tenant', register_service_principal.tenant,
    'name', register_service_principal.name, 'role', register_service_principal.role,
    'isDefault', coalesce(register_service_principal.is_default, false));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.register_sso_provider (
  tenant       uuid,
  provider     uuid,
  domains      text[],
  metadata_url text   DEFAULT NULL::text,
  actor        uuid   DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_row "better_supabase"."sso_providers";
begin
  perform "better_supabase"."check_sso_provider"(register_sso_provider.tenant, register_sso_provider.domains, register_sso_provider.actor);
  insert into "better_supabase"."sso_providers" as x ("id", "tenant_id", "metadata_url", "domains")
  values (register_sso_provider.provider, register_sso_provider.tenant, register_sso_provider.metadata_url,
    (select array_agg(distinct lower(w.domain) order by lower(w.domain)) from unnest(register_sso_provider.domains) as w(domain)))
  on conflict ("id") do update set "metadata_url" = excluded."metadata_url", "domains" = excluded."domains"
  where x."tenant_id" = excluded."tenant_id"
  returning * into v_row;
  if v_row."id" is null then
    raise exception 'The provider belongs to another organization' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  perform better_supabase.audit_event(
    event_type => 'sso_provider.registered',
    category => 'security',
    target_type => 'sso_provider',
    record_id => v_row."id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'providerId', v_row."id", 'domains', to_jsonb(v_row."domains"), 'userId', register_sso_provider.actor),
    actor_id => register_sso_provider.actor
  );
  return to_jsonb(v_row);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.relation_rollup (
  tenant       uuid,
  kind         text,
  subject_type text,
  subject_id   text,
  of_type      text,
  column_name  text,
  agg          text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_table text;
  v_id_col text;
  v_tenant_col text;
  v_ids text[];
  v_result jsonb;
begin
  if relation_rollup.agg is null or relation_rollup.agg not in ('count', 'sum', 'avg', 'min', 'max') then
    raise exception 'agg must be count, sum, avg, min or max' using errcode = '22023', hint = 'RELATION_ROLLUP_INVALID';
  end if;
  if relation_rollup.agg <> 'count' and relation_rollup.column_name is null then
    raise exception 'this aggregate needs a column' using errcode = '22023', hint = 'RELATION_ROLLUP_INVALID';
  end if;
  
  if v_table is null then
    raise exception 'this subject type has no table' using errcode = '22023', hint = 'RELATION_SUBJECT_UNKNOWN';
  end if;
  select array_agg(w.id) into v_ids
  from "better_supabase"."relation_walk"(relation_rollup.tenant, relation_rollup.kind, relation_rollup.subject_type, relation_rollup.subject_id, false, null) w
  where w.type = relation_rollup.of_type;
  execute format(
    'select to_jsonb(%s) from %s s where s.%I::text = any ($1)%s',
    case when relation_rollup.agg = 'count' and relation_rollup.column_name is null then 'count(*)'
      else format('%s(s.%I)', relation_rollup.agg, relation_rollup.column_name) end,
    v_table,
    v_id_col,
    case when v_tenant_col is null then '' else format(' and s.%I = $2', v_tenant_col) end
  ) into v_result using coalesce(v_ids, '{}'::text[]), relation_rollup.tenant;
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.relation_walk (
  tenant       uuid,
  kind         text,
  subject_type text,
  subject_id   text,
  up           boolean,
  max_depth    integer
)
  RETURNS TABLE (
    type  text,
    id    text,
    depth integer
  )
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_kind text;
  v_inverted boolean;
  v_up boolean;
begin
  select k.canonical, k.inverted into v_kind, v_inverted from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = relation_walk.kind;
  if v_kind is null then
    raise exception 'unknown relation kind' using errcode = '22023', hint = 'RELATION_KIND_UNKNOWN';
  end if;
  v_up := relation_walk.up <> v_inverted;
  return query
  with recursive walk(t, i, d) as (
    select relation_walk.subject_type, relation_walk.subject_id, 0
    union
    select case when v_up then r."target_type" else r."source_type" end,
      case when v_up then r."target_id" else r."source_id" end,
      walk.d + 1
    from "better_supabase"."relations" r join walk on (
      case when v_up then r."source_type" = walk.t and r."source_id" = walk.i
      else r."target_type" = walk.t and r."target_id" = walk.i end)
    where r."tenant_id" = relation_walk.tenant and r."kind" = v_kind
      and walk.d < least(coalesce(relation_walk.max_depth, 100), 100)
  )
  select w.t, w.i, min(w.d)::integer from walk w where w.d > 0
  group by w.t, w.i
  order by min(w.d), w.t, w.i;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.relations_by_kind (
  tenant uuid,
  kind   text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r."id", 'kind', r."kind",
    'sourceType', r."source_type", 'sourceId', r."source_id",
    'targetType', r."target_type", 'targetId', r."target_id",
    'data', r."data"
  ) order by r."created_at", r."id"), '[]'::jsonb)
  from (
    select * from "better_supabase"."relations" r
    where r."tenant_id" = relations_by_kind.tenant
      and r."kind" = (select k.canonical from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = relations_by_kind.kind)
    order by r."created_at", r."id"
    limit 10000
  ) r
$function$;

CREATE OR REPLACE FUNCTION better_supabase.relations_of (
  tenant       uuid,
  subject_type text,
  subject_id   text,
  kind         text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'kind', n.seen, 'direction', e.direction,
    'type', e.other_type, 'subjectId', e.other_id,
    'data', e.data, 'createdAt', e.created_at
  ) order by n.seen, e.created_at, e.id), '[]'::jsonb)
  from (
    select r."id" as id, r."kind" as canonical, 'out' as direction,
      r."target_type" as other_type, r."target_id" as other_id, r."data" as data, r."created_at" as created_at
    from "better_supabase"."relations" r
    where r."tenant_id" = relations_of.tenant and r."source_type" = relations_of.subject_type and r."source_id" = relations_of.subject_id
    union all
    select r."id", r."kind", 'in', r."source_type", r."source_id", r."data", r."created_at"
    from "better_supabase"."relations" r
    where r."tenant_id" = relations_of.tenant and r."target_type" = relations_of.subject_type and r."target_id" = relations_of.subject_id
  ) e
  cross join lateral (
    select case when e.direction = 'in' and not k.both_ways then k.opposite else k.canonical end as seen
    from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite)
    where k.name = e.canonical
  ) n
  where relations_of.kind is null or n.seen = relations_of.kind
$function$;

CREATE OR REPLACE FUNCTION better_supabase.remind_approvals (
  after        interval DEFAULT '1 day'::interval,
  max_requests integer  DEFAULT 200
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    update "better_supabase"."approval_requests" r set "reminded_at" = now()
    where r."id" in (
      select x."id" from "better_supabase"."approval_requests" x
      where x."status" = 'pending'
        and (x."expires_at" is null or x."expires_at" > now())
        and x."created_at" <= now() - remind_approvals.after
        and (x."reminded_at" is null or x."reminded_at" <= now() - remind_approvals.after)
      order by x."created_at"
      limit greatest(coalesce(remind_approvals.max_requests, 200), 1)
      for update skip locked
    )
    returning r."id"
  loop
    perform "better_supabase"."approval_notify"(v_id, 'reminder');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.remove_member (
  organization uuid,
  member       uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  current_role_value text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if member = auth.uid() then
    raise exception 'Leave the organization instead' using errcode = '22023', hint = 'ORGANIZATION_SELF';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), organization, 'members.remove'), false)) then
    raise exception 'Not allowed to remove members' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  select m."role"::text into current_role_value from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = member;
  if not found then
    raise exception 'Not a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  if not better_supabase.can_assign(organization, current_role_value) then
    raise exception 'That member''s role is above your own' using errcode = '42501', hint = 'ORGANIZATION_ROLE_CEILING';
  end if;
  delete from "public"."organization_memberships" where "organization_id" = organization and "user_id" = member;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_member_change"(uuid, uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text)', v_hook::oid::regproc)
        using organization, member, 'removed';
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.member_removed',
    category => 'membership',
    target_type => 'user',
    record_id => member::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', member)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.remove_organization_domain (
  id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."sso_domains";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."sso_domains" x where x."id" = remove_organization_domain.id;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'sso.manage'), false)) then
    return false;
  end if;
  if exists (select 1 from "better_supabase"."sso_providers" sp where sp."tenant_id" = v_row."tenant_id" and v_row."domain" = any (sp."domains")) then
    raise exception 'An SSO provider uses this domain; remove it first' using errcode = '23503', hint = 'SSO_DOMAIN_IN_USE';
  end if;
  delete from "better_supabase"."sso_domains" x where x."id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'sso_domain.deleted',
    category => 'security',
    target_type => 'domain',
    record_id => v_row."id"::text,
    target_label => v_row."domain",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'domainId', v_row."id", 'domain', v_row."domain", 'userId', auth.uid()),
    actor_id => auth.uid()
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.remove_rule (
  id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."automations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."automations" x where x."id" = remove_rule.id;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.manage'), false)) then
    return false;
  end if;
  if v_row."default_key" is not null then
    raise exception 'A block ships this automation; turn it off instead of removing it' using errcode = '22023', hint = 'AUTOMATION_DEFAULT';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_automation_remove"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using remove_rule.id;
    end if;
  end;
  delete from "better_supabase"."automations" x where x."id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'automation.deleted',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_automation_remove"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.remove_team_member (
  team   uuid,
  member uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select "tenant_id" into v_tenant from "better_supabase"."teams" where "id" = remove_team_member.team;
  if not found then
    raise exception 'team not found' using errcode = 'P0002', hint = 'TEAM_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'teams.manage'), false)) then
    raise exception 'not allowed to manage teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  delete from "better_supabase"."team_members"
  where "team_id" = remove_team_member.team and "user_id" = remove_team_member.member;
  perform better_supabase.audit_event(
    event_type => 'team_member.deleted',
    category => 'membership',
    target_type => 'team',
    record_id => (remove_team_member.team)::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant, 'id', remove_team_member.team, 'userId', remove_team_member.member)
  );
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.remove_usage_quota (
  tenant uuid,
  plan   text,
  meter  text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
begin
  if (tenant is null) = (plan is null) then
    raise exception 'remove_usage_quota needs a tenant or a plan, not both' using errcode = '22023', hint = 'USAGE_QUOTA_TARGET';
  end if;
  delete from "better_supabase"."usage_quotas" q
  where q."meter" = meter
    and q."tenant_id" is not distinct from tenant
    and q."plan" is not distinct from plan;
  return found;
end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.request_access (
  tenant   uuid,
  role     text,
  reason   text     DEFAULT NULL::text,
  duration interval DEFAULT NULL::interval
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  SET "IntervalStyle" TO 'iso_8601'
  AS $function$
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_current text;
  v_duration interval;
  v_row "better_supabase"."access_requests"%rowtype;
  v_approval jsonb;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if v_me is null then
    raise exception 'sign in to request access' using errcode = '42501', hint = 'ACCESS_SIGN_IN';
  end if;
  select m."role" into v_current from "public"."organization_memberships" m
  where m."organization_id" = request_access.tenant and m."user_id" = v_me;
  if not found then
    raise exception 'only members can request a role' using errcode = '42501', hint = 'ACCESS_REQUEST_FORBIDDEN';
  elsif not coalesce(better_supabase.can('tenant', request_access.tenant, 'access_requests.create'), false) then
    raise exception 'not allowed to request a role here' using errcode = '42501', hint = 'ACCESS_REQUEST_FORBIDDEN';
  end if;
  if not (request_access.role = any (array['admin', 'member', 'viewer']::text[])) then
    raise exception 'this role can''t be requested' using errcode = '22023', hint = 'ACCESS_ROLE_INVALID';
  end if;
  if v_current = request_access.role then
    raise exception 'you already hold this role' using errcode = '22023', hint = 'ACCESS_ROLE_HELD';
  end if;
  if v_current = 'owner' then
    raise exception 'an owner can''t request another role' using errcode = '22023', hint = 'ACCESS_ROLE_INVALID';
  end if;
  v_duration := request_access.duration;
  if v_duration is not null and v_duration <= interval '0' then
    raise exception 'duration must be positive' using errcode = '22023', hint = 'ACCESS_DURATION_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('access_request:' || request_access.tenant::text || ':' || v_me::text, 0));
  if exists (
    select 1 from "better_supabase"."access_requests" r join "better_supabase"."approval_requests" x on x."id" = r."approval_id"
    where r."tenant_id" = request_access.tenant and r."user_id" = v_me and x."status" = 'pending'
  ) then
    raise exception 'you already have a pending access request here' using errcode = '23505', hint = 'ACCESS_REQUEST_PENDING';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_access_request"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using request_access.tenant, request_access.role;
    end if;
  end;
  insert into "better_supabase"."access_requests" ("tenant_id", "user_id", "role", "reason", "duration")
  values (request_access.tenant, v_me, request_access.role, request_access.reason, v_duration)
  returning * into v_row;
  v_approval := "better_supabase"."open_approval"(
    request_access.tenant, 'access_request', v_row."id"::text, 'grant',
    '{"steps":[{"approvers":{"permission":"members.update_role"},"required":1}],"selfApproval":false,"expiresIn":null,"run":null}'::jsonb, request_access.reason,
    jsonb_build_object('role', request_access.role, 'userId', v_me, 'duration', v_duration::text)
  );
  update "better_supabase"."access_requests" r set "approval_id" = (v_approval ->> 'id')::uuid
  where r."id" = v_row."id"
  returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'access_request.requested',
    category => 'membership',
    target_type => 'user',
    record_id => v_row."user_id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'userId', v_row."user_id", 'role', v_row."role", 'id', v_row."id", 'approvalId', v_row."approval_id", 'expiresAt', v_row."expires_at", 'target', 'role', 'subjectType', null::text, 'subjectId', null::text, 'action', null::text)
  );
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_access_request"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'userId', v_row."user_id", 'role', v_row."role", 'previousRole', v_row."previous_role", 'reason', v_row."reason", 'duration', v_row."duration"::text, 'status', 'pending', 'approvalId', v_row."approval_id", 'grantedAt', v_row."granted_at", 'expiresAt', v_row."expires_at", 'endedAt', v_row."ended_at", 'createdAt', v_row."created_at");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.request_approval (
  tenant       uuid,
  subject_type text,
  subject_id   text,
  action       text,
  reason       text  DEFAULT NULL::text,
  payload      jsonb DEFAULT '{}'::jsonb,
  fingerprint  text  DEFAULT NULL::text,
  policy       jsonb DEFAULT NULL::jsonb,
  requested_by uuid  DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_policy jsonb := "better_supabase"."approval_effective_policy"(request_approval.tenant, request_approval.subject_type, request_approval.action, coalesce(request_approval.payload, '{}'::jsonb));
  v_service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  v_result jsonb;
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if request_approval.policy is not null and not v_service then
    raise exception 'only the service role files a request under its own policy' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if request_approval.requested_by is not null and not v_service and request_approval.requested_by is distinct from auth.uid() then
    raise exception 'only the service role files a request for another user' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if request_approval.policy is not null then
    v_policy := "better_supabase"."approval_policy_tighten"(v_policy, request_approval.policy);
  end if;
  if v_policy is null then
    raise exception 'no approval policy for this subject type and action' using errcode = '22023', hint = 'APPROVAL_POLICY_UNKNOWN';
  end if;
  if not (v_service or (coalesce(better_supabase.can('tenant', request_approval.tenant, 'approvals.request'), false) and true)) then
    raise exception 'not allowed to request approval for this record' using errcode = '42501', hint = 'APPROVAL_FORBIDDEN';
  end if;
  if not (coalesce(v_policy ->> 'mode', 'authorize') = 'confirm' or jsonb_array_length(coalesce(v_policy -> 'steps', '[]'::jsonb)) > 0) then
    raise exception 'no approval is required for this request' using errcode = '22023', hint = 'APPROVAL_NOT_REQUIRED';
  end if;
  if request_approval.fingerprint is not null and request_approval.fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'fingerprint must be a lowercase hex SHA-256' using errcode = '22023', hint = 'APPROVAL_FINGERPRINT_INVALID';
  end if;
  v_result := "better_supabase"."open_approval"(request_approval.tenant, request_approval.subject_type, request_approval.subject_id, request_approval.action, v_policy, request_approval.reason, request_approval.payload, coalesce(request_approval.requested_by, auth.uid()));
  if request_approval.fingerprint is not null then
    update "better_supabase"."approval_requests" x set "fingerprint" = request_approval.fingerprint
    where x."id" = (v_result ->> 'id')::uuid and x."status" = 'pending';
  end if;
  select * into v_req from "better_supabase"."approval_requests" x where x."id" = (v_result ->> 'id')::uuid;
  if found then
    return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at");
  end if;
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.request_approval_items (
  tenant       uuid,
  subject_type text,
  subject_id   text,
  action       text,
  items        jsonb,
  reason       text  DEFAULT NULL::text,
  payload      jsonb DEFAULT '{}'::jsonb,
  fingerprint  text  DEFAULT NULL::text,
  policy       jsonb DEFAULT NULL::jsonb,
  requested_by uuid  DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_result jsonb;
  v_item jsonb;
  v_key text;
  v_seen text[] := '{}';
  v_after text[];
  v_depends text[];
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if jsonb_typeof(request_approval_items.items) is distinct from 'array' or jsonb_array_length(request_approval_items.items) = 0 then
    raise exception 'items must be a non-empty array' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
  end if;
  if jsonb_array_length(request_approval_items.items) > 200 then
    raise exception 'a request takes at most 200 items' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
  end if;
  if request_approval_items.subject_type in ('support_request') then
    raise exception 'the module that filed this request decides it, so it takes no items' using errcode = '22023', hint = 'APPROVAL_ITEMS_UNSUPPORTED';
  end if;
  for v_item in select e.value from jsonb_array_elements(request_approval_items.items) e loop
    if jsonb_typeof(v_item) is distinct from 'object' or jsonb_typeof(v_item -> 'key') is distinct from 'string' or length(btrim(v_item ->> 'key')) not between 1 and 200 then
      raise exception 'each item needs a key of 1 to 200 characters' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
    end if;
    v_key := v_item ->> 'key';
    if v_key = any(v_seen) then
      raise exception 'item keys must be unique' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
    end if;
    if v_item ? 'dependsOn' and jsonb_typeof(v_item -> 'dependsOn') is distinct from 'array' then
      raise exception 'dependsOn must be an array of item keys' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
    end if;
    v_depends := array(select jsonb_array_elements_text(coalesce(v_item -> 'dependsOn', '[]'::jsonb)));
    if exists (select 1 from unnest(v_depends) dep where dep <> all(v_seen)) then
      raise exception 'an item depends only on items listed before it' using errcode = '22023', hint = 'APPROVAL_ITEMS_INVALID';
    end if;
    v_seen := v_seen || v_key;
  end loop;
  v_result := "better_supabase"."request_approval"(
    tenant => request_approval_items.tenant,
    subject_type => request_approval_items.subject_type,
    subject_id => request_approval_items.subject_id,
    action => request_approval_items.action,
    reason => request_approval_items.reason,
    payload => request_approval_items.payload,
    fingerprint => request_approval_items.fingerprint,
    policy => request_approval_items.policy,
    requested_by => request_approval_items.requested_by
  );
  insert into "better_supabase"."approval_items" ("request_id", "tenant_id", "key", "label", "payload", "permission", "depends_on")
  select (v_result ->> 'id')::uuid, request_approval_items.tenant, e.value ->> 'key', e.value ->> 'label',
    case when jsonb_typeof(e.value -> 'payload') = 'object' then e.value -> 'payload' else '{}'::jsonb end,
    nullif(e.value ->> 'permission', ''),
    array(select jsonb_array_elements_text(coalesce(e.value -> 'dependsOn', '[]'::jsonb)))
  from jsonb_array_elements(request_approval_items.items) with ordinality e(value, position)
  order by e.position;
  return v_result || jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = (v_result ->> 'id')::uuid
    ), '[]'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.request_support_session (
  target      uuid,
  reason      text    DEFAULT NULL::text,
  read_only   boolean DEFAULT true,
  metadata    jsonb   DEFAULT '{}'::jsonb,
  tenant      uuid    DEFAULT NULL::uuid,
  admin_id    uuid    DEFAULT NULL::uuid,
  approved_by uuid    DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  admin uuid;
  new_id uuid;
  requested jsonb;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if service then
    admin := admin_id;
    if admin is null then
      raise exception 'admin_id is required for the service role' using errcode = '22023', hint = 'IMPERSONATION_FORBIDDEN';
    end if;
  else
    admin := auth.uid();
    if admin is null or (admin_id is not null and admin_id <> admin) or approved_by is not null
      or not "better_supabase"."is_platform"('impersonation.start') then
      raise exception 'Not allowed to ask for a support session' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
    end if;
  end if;
  if target = admin then
    raise exception 'An admin cannot start a support session as themselves' using errcode = '22023', hint = 'IMPERSONATION_SELF';
  end if;
  if approved_by = admin then
    raise exception 'An admin cannot approve their own support session' using errcode = '42501', hint = 'IMPERSONATION_SELF_APPROVAL';
  end if;
  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception 'No user %', target using errcode = 'P0002', hint = 'IMPERSONATION_TARGET_MISSING';
  end if;
  if coalesce(btrim(reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023', hint = 'IMPERSONATION_REASON_REQUIRED';
  end if;
  if not coalesce(read_only, true) then
    raise exception 'Support sessions are read-only (blocks.impersonation.options.allowWrites)' using errcode = '42501', hint = 'IMPERSONATION_WRITES_DISABLED';
  end if;
  insert into "better_supabase"."support_requests" ("admin_id", "target_id", "reason", "tenant_id", "read_only", "metadata", "expires_at", "approved_by", "approved_at")
  values (admin, target, coalesce(btrim(reason), ''), tenant, coalesce(read_only, true), coalesce(metadata, '{}'),
    now() + '1 hour'::interval, approved_by, case when approved_by is null then null else now() end)
  returning "id" into new_id;
  if tenant is not null and approved_by is null then
    perform "better_supabase"."open_approval"(
      tenant, 'support_request', new_id::text, 'start', jsonb_build_object('steps', '[{"approvers": {}, "required": 1}]'::jsonb, 'selfApproval', false, 'expiresIn', '1 hour', 'run', null), coalesce(btrim(reason), ''),
      jsonb_build_object('adminId', admin, 'targetUserId', target, 'readOnly', coalesce(read_only, true))
    );
  end if;
  select jsonb_build_object(
    'id', x."id",
    'admin_id', x."admin_id",
    'target_user_id', x."target_id",
    'reason', x."reason",
    'tenant', x."tenant_id",
    'read_only', x."read_only",
    'metadata', x."metadata",
    'requested_at', x."requested_at",
    'expires_at', x."expires_at",
    'approved_by', x."approved_by",
    'approved_at', x."approved_at",
    'session_id', x."session_id"
  ) into requested from "better_supabase"."support_requests" x where x."id" = new_id;
  return requested;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.resend_invitation (
  invitation_id uuid,
  valid_for     interval DEFAULT '7 days'::interval
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  token text := encode(extensions.gen_random_bytes(24), 'hex');
  updated "better_supabase"."invitations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if valid_for is null or valid_for <= interval '0' or valid_for > '30 days'::interval then
    raise exception 'An invitation is valid for at most %', '30 days' using errcode = '22023', hint = 'INVITATION_VALIDITY';
  end if;
  update "better_supabase"."invitations" i
  set "token_hash" = encode(extensions.digest(token, 'sha256'), 'hex'),
    "expires_at" = now() + valid_for
  where i."id" = invitation_id and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
    and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), i."tenant_id", 'members.invite'), false))
  returning * into updated;
  if updated."id" is null then
    raise exception 'No open invitation %', invitation_id using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  perform better_supabase.audit_event(
    event_type => 'invitation.resent',
    category => 'membership',
    target_type => 'invitation',
    record_id => updated."id"::text,
    tenant => (updated."tenant_id")::uuid,
    metadata => jsonb_build_object('invitationId', updated."id", 'organizationId', updated."tenant_id"::text, 'email', updated."email")
  );
  return (jsonb_build_object(
    'id', updated."id",
    'tenant', updated."tenant_id",
    'email', updated."email",
    'role', updated."role",
    'expires_at', updated."expires_at",
    'created_at', updated."created_at",
    'invited_by', updated."invited_by",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = updated."tenant_id"),
    'prefill', '{}'::jsonb,
    'token', token
  ) || "better_supabase"."invitation_extra"(updated."id"));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.resend_invitations (
  invitation_ids uuid[],
  valid_for      interval DEFAULT '7 days'::interval
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_id uuid;
  v_sent jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(invitation_ids), 0) > 1000 then
    raise exception 'Resend at most 1000 invitations in one call' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  for v_id in select x from unnest(invitation_ids) with ordinality u(x, n) where x is not null group by x order by min(n) loop
    v_sent := v_sent || jsonb_build_array("better_supabase"."resend_invitation"(v_id, valid_for));
  end loop;
  return v_sent;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.reset_default_rule (
  id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."automations";
  v_default "better_supabase"."automation_defaults";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."automations" x where x."id" = reset_default_rule.id for update;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.read'), false)) then
    raise exception 'No rule you can read has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
  end if;
  select * into v_default from "better_supabase"."automation_defaults" x where x."key" = v_row."default_key";
  if v_default."key" is null then
    raise exception 'No block ships this rule' using errcode = '22023', hint = 'AUTOMATION_NOT_DEFAULT';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (case when (v_row."enabled" or v_default."enabled") then coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.publish'), false) else coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.write'), false) end)) then
    raise exception 'You need % to reset this rule', case when (v_row."enabled" or v_default."enabled") then '''automations.publish''' else '''automations.write''' end using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  update "better_supabase"."automations" x set
    "trigger" = v_default."trigger",
    "name" = v_default."name",
    "description" = v_default."description",
    "conditions" = v_default."conditions",
    "actions" = v_default."actions",
    "enabled" = v_default."enabled",
    "stop_processing" = false,
    "version" = x."version" + 1,
    "updated_by" = auth.uid(),
    "updated_at" = now()
  where x."id" = v_row."id"
  returning * into v_row;
  insert into "better_supabase"."automation_versions" ("rule_id", "version", "tenant_id", "name", "conditions", "actions", "saved_by")
  values (v_row."id", v_row."version", v_row."tenant_id", v_row."name", v_row."conditions", v_row."actions", auth.uid())
  on conflict do nothing;
  perform better_supabase.audit_event(
    event_type => 'automation.updated',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.reset_organization_setting (
  tenant uuid,
  key    text
)
  RETURNS boolean
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  with removed as (
    delete from "better_supabase"."organization_settings" s
    where s."tenant_id" = reset_organization_setting.tenant and s."key" = reset_organization_setting.key
    returning 1
  )
  select exists (select 1 from removed)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.reset_platform_setting (
  key text
)
  RETURNS boolean
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  with removed as (
    delete from "better_supabase"."platform_settings" s where s."key" = reset_platform_setting.key
    returning 1
  )
  select exists (select 1 from removed)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.reset_user_setting (
  key text
)
  RETURNS boolean
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  with removed as (
    delete from "better_supabase"."user_settings" s where s."user_id" = auth.uid() and s."key" = reset_user_setting.key
    returning 1
  )
  select exists (select 1 from removed)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.revoke_api_key (
  key uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  found "better_supabase"."api_keys";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into found from "better_supabase"."api_keys" k where k."id" = revoke_api_key.key;
  if found."id" is null or not ((found."tenant_id" is not null and coalesce(better_supabase.can('tenant', found."tenant_id", 'api_keys.manage'), false)) or coalesce(found."user_id" = auth.uid(), false) or coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'API key not found' using errcode = 'P0002', hint = 'API_KEY_NOT_FOUND';
  end if;
  update "better_supabase"."api_keys" k set "revoked_at" = now()
  where k."id" = found."id" and (k."revoked_at" is null or k."revoked_at" > now());
  perform better_supabase.audit_event(
    event_type => 'api_key.revoked',
    category => 'security',
    target_type => 'api_key',
    record_id => found."id"::text,
    target_label => found."name",
    tenant => (found."tenant_id")::uuid,
    metadata => jsonb_build_object('keyId', found."id", 'organizationId', found."tenant_id"::text, 'userId', found."user_id", 'name', found."name", 'publicId', found."public_id")
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.revoke_invitation (
  invitation_id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  tenant text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  update "better_supabase"."invitations" i set "revoked_at" = now() where i."id" = invitation_id and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), i."tenant_id", 'members.invite'), false)) and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  returning i."tenant_id"::text into tenant;
  if found then
    perform better_supabase.audit_event(
    event_type => 'invitation.revoked',
    category => 'membership',
    target_type => 'invitation',
    record_id => invitation_id::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', invitation_id, 'organizationId', tenant)
  );
    return true;
  end if;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rotate_api_key (
  key         uuid,
  public_id   text,
  secret_hash text,
  grace       interval DEFAULT '1 day'::interval
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  old "better_supabase"."api_keys";
  created "better_supabase"."api_keys";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into old from "better_supabase"."api_keys" k where k."id" = rotate_api_key.key for update;
  if old."id" is null or not ((old."tenant_id" is not null and coalesce(better_supabase.can('tenant', old."tenant_id", 'api_keys.manage'), false)) or coalesce(old."user_id" = auth.uid(), false) or coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'API key not found' using errcode = 'P0002', hint = 'API_KEY_NOT_FOUND';
  end if;
  -- The new secret acts as the key's user, so only that user rotates a personal key.
  if old."user_id" is not null and old."user_id" is distinct from auth.uid() and not coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'Only its own user can rotate a personal key; revoke it instead' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
  end if;
  if (auth.jwt() -> 'api_key' is not null
      or coalesce(auth.jwt() ->> 'client_id', '') <> ''
      or auth.jwt() -> 'act' is not null) and exists (
    select 1 from unnest(coalesce(old."scopes", '{}')) s
    where not case
      when auth.jwt() -> 'api_key' is not null then
        coalesce(auth.jwt() -> 'api_key' -> 'scopes', '[]'::jsonb) ?| array['*', s]
      else exists (
        select 1
        from unnest(case jsonb_typeof(auth.jwt() -> 'scope')
            when 'string' then regexp_split_to_array(btrim(auth.jwt() ->> 'scope'), '\s+')
            when 'array' then array(select jsonb_array_elements_text(auth.jwt() -> 'scope'))
            else '{}'::text[]
          end) t(scope)
        where t.scope <> ''
          and (t.scope = s or exists (
            select 1 from unnest(better_supabase.scope_permissions(t.scope)) k(key)
            where better_supabase.permission_matches(k.key, s)
          ))
      )
    end
  ) then
    raise exception 'A token may only give a key the scopes it holds itself' using errcode = '42501', hint = 'API_KEY_FORBIDDEN';
  end if;
  if old."revoked_at" is not null and old."revoked_at" <= now() then
    raise exception 'A revoked API key cannot be rotated' using errcode = '22023', hint = 'API_KEY_REVOKED';
  end if;
  if old."expires_at" is not null and old."expires_at" <= now() then
    raise exception 'An expired API key cannot be rotated' using errcode = '22023', hint = 'API_KEY_EXPIRED';
  end if;
  if grace is null or grace < interval '0' then
    raise exception 'grace must be zero or more' using errcode = '22023', hint = 'API_KEY_GRACE';
  end if;
  insert into "better_supabase"."api_keys" ("tenant_id", "user_id", "name", "prefix", "public_id", "secret_hash", "scopes", "kind", "rate_limit", "expires_at", "rotated_from")
  values (old."tenant_id", old."user_id", old."name", old."prefix", rotate_api_key.public_id, rotate_api_key.secret_hash, old."scopes", old."kind", old."rate_limit", old."expires_at", old."id")
  returning * into created;
  update "better_supabase"."api_keys" k set "revoked_at" = now() + grace where k."id" = old."id";
  perform better_supabase.audit_event(
    event_type => 'api_key.rotated',
    category => 'security',
    target_type => 'api_key',
    record_id => created."id"::text,
    target_label => created."name",
    tenant => (created."tenant_id")::uuid,
    metadata => jsonb_build_object('keyId', created."id", 'organizationId', created."tenant_id"::text, 'userId', created."user_id", 'name', created."name", 'publicId', created."public_id", 'previousKeyId', old."id")
  );
  return jsonb_build_object(
    'id', created."id",
    'organization_id', created."tenant_id",
    'user_id', created."user_id",
    'name', created."name",
    'prefix', created."prefix",
    'public_id', created."public_id",
    'scopes', to_jsonb(created."scopes"),
    'kind', created."kind",
    'rate_limit', created."rate_limit",
    'expires_at', created."expires_at",
    'last_used_at', created."last_used_at",
    'revoked_at', created."revoked_at",
    'rotated_from', created."rotated_from",
    'created_by', created."created_by",
    'created_at', created."created_at",
    'state', case
      when created."revoked_at" is not null and created."revoked_at" <= now() then 'revoked'
      when created."expires_at" is not null and created."expires_at" <= now() then 'expired'
      when created."revoked_at" is not null then 'grace'
      else 'active'
    end,
    'successor_id', (select s."id" from "better_supabase"."api_keys" s where s."rotated_from" = created."id" order by s."created_at" desc limit 1)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_boolean (
  value jsonb
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case
    when jsonb_typeof(value) = 'boolean' then (value #>> '{}')::boolean
    when value = '"true"'::jsonb then true
    when value = '"false"'::jsonb then false
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_bounds (
  kind      text,
  value     jsonb,
  time_zone text,
  now       timestamp with time zone
)
  RETURNS timestamp WITHOUT time zone[]
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_day date;
  v_offset integer;
  v_time time;
  v_from timestamp;
  v_to timestamp;
begin
  if jsonb_typeof(value -> 'relative') = 'object' then
    v_day := (rule_bounds.now at time zone rule_bounds.time_zone)::date;
    v_offset := coalesce((value -> 'relative' ->> 'offset')::integer, 0);
    v_day := (v_day + case value -> 'relative' ->> 'unit'
      when 'day' then make_interval(days => v_offset)
      when 'week' then make_interval(weeks => v_offset)
      when 'month' then make_interval(months => v_offset)
      else make_interval(years => v_offset)
    end)::date;
  else
    v_day := (value ->> 'date')::date;
  end if;
  if kind = 'date' then
    return array[v_day::timestamp, (v_day + 1)::timestamp];
  end if;
  v_time := (value ->> 'time')::time;
  v_from := v_day + coalesce(v_time, time '00:00');
  v_to := case when v_time is null then v_from + interval '1 day' else v_from + interval '1 minute' end;
  if kind = 'timestamp' then
    return array[v_from, v_to];
  end if;
  return array[
    (v_from at time zone rule_bounds.time_zone) at time zone 'UTC',
    (v_to at time zone rule_bounds.time_zone) at time zone 'UTC'
  ];
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_check (
  node   jsonb,
  fields jsonb,
  depth  integer DEFAULT 1
)
  RETURNS integer
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_operators constant jsonb := '{"text":{"contains":"one","not_contains":"one","starts_with":"one","ends_with":"one","is":"one","is_not":"one","empty":"none","not_empty":"none"},"number":{"eq":"one","neq":"one","gt":"one","gte":"one","lt":"one","lte":"one","between":"range","not_between":"range","empty":"none","not_empty":"none"},"date":{"is":"one","is_not":"one","is_before":"one","is_after":"one","is_on_or_before":"one","is_on_or_after":"one","between":"range","not_between":"range","empty":"none","not_empty":"none"},"select":{"is":"one","is_not":"one","is_any_of":"many","is_none_of":"many","empty":"none","not_empty":"none"},"relation":{"is":"one","is_not":"one","is_any_of":"many","is_none_of":"many","empty":"none","not_empty":"none"},"multiselect":{"has_any_of":"many","has_all_of":"many","has_none_of":"many","empty":"none","not_empty":"none"},"boolean":{"is":"one","is_not":"one","empty":"none","not_empty":"none"}}'::jsonb;
  v_field jsonb;
  v_path text;
  v_operator text;
  v_arity text;
  v_count integer := 0;
  v_child jsonb;
begin
  if jsonb_typeof(node) is distinct from 'object' or jsonb_typeof(node -> 'id') is distinct from 'string'
    or length(node ->> 'id') not between 1 and 64 then
    raise exception 'Every condition and group needs an id' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if node ->> 'type' = 'rule' then
    if jsonb_typeof(node -> 'path') is distinct from 'array' or jsonb_array_length(node -> 'path') = 0 then
      raise exception 'A condition needs a field path' using errcode = '22023', hint = 'AUTOMATION_INVALID';
    end if;
    v_operator := coalesce(node ->> 'operator', '');
    if v_operator = '' then
      return 0;
    end if;
    select string_agg(p.value, '.' order by p.n) into v_path
    from jsonb_array_elements_text(node -> 'path') with ordinality p(value, n);
    v_field := fields -> v_path;
    if v_field is null then
      raise exception 'No rule field %', v_path using errcode = '22023', hint = 'RULE_FIELD_UNKNOWN';
    end if;
    v_arity := v_operators -> (v_field ->> 'type') ->> v_operator;
    if v_arity is null or (jsonb_typeof(v_field -> 'operators') = 'array' and not (v_field -> 'operators') ? v_operator) then
      raise exception 'The field % has no operator %', v_path, v_operator using errcode = '22023', hint = 'RULE_OPERATOR_INVALID';
    end if;
    if (v_arity = 'one' and coalesce(jsonb_typeof(node -> 'value'), 'null') = 'null')
      or (v_arity = 'one' and v_field ->> 'type' = 'date' and jsonb_typeof(node -> 'value') is distinct from 'object')
      or (v_arity = 'many' and (jsonb_typeof(node -> 'value') is distinct from 'array' or jsonb_array_length(node -> 'value') not between 1 and 100))
      or (v_arity = 'range' and (jsonb_typeof(node -> 'value') is distinct from 'array' or jsonb_array_length(node -> 'value') <> 2)) then
      raise exception 'The condition on % has no valid value for %', v_path, v_operator using errcode = '22023', hint = 'RULE_VALUE_INVALID';
    end if;
    if (node -> 'value') is not null and v_arity <> 'none' and length((node -> 'value')::text) > 10000 then
      raise exception 'The value for % is too long', v_path using errcode = '22023', hint = 'RULE_VALUE_INVALID';
    end if;
    return 1;
  end if;
  if node ->> 'type' is distinct from 'group' or coalesce(node ->> 'combinator', '') not in ('and', 'or')
    or jsonb_typeof(node -> 'rules') is distinct from 'array' then
    raise exception 'A group needs a combinator (and, or) and a list of rules' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if depth > 4 then
    raise exception 'Groups nest at most 4 deep' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  for v_child in select x.value from jsonb_array_elements(node -> 'rules') x loop
    v_count := v_count + "better_supabase"."rule_check"(v_child, fields, depth + 1);
  end loop;
  if v_count > 50 then
    raise exception 'A rule holds at most 50 conditions' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_date (
  kind      text,
  operator  text,
  operand   jsonb,
  value     jsonb,
  time_zone text,
  now       timestamp with time zone
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_at timestamp := "better_supabase"."rule_moment"(kind, value);
  v_bounds timestamp[];
begin
  if v_at is null then
    return null;
  end if;
  if operator = 'between' then
    return v_at >= ("better_supabase"."rule_bounds"(kind, operand -> 0, time_zone, now))[1]
      and v_at < ("better_supabase"."rule_bounds"(kind, operand -> 1, time_zone, now))[2];
  end if;
  v_bounds := "better_supabase"."rule_bounds"(kind, operand, time_zone, now);
  case operator
    when 'is' then return v_at >= v_bounds[1] and v_at < v_bounds[2];
    when 'is_before' then return v_at < v_bounds[1];
    when 'is_after' then return v_at >= v_bounds[2];
    when 'is_on_or_before' then return v_at < v_bounds[2];
    when 'is_on_or_after' then return v_at >= v_bounds[1];
  end case;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_equal (
  type    text,
  operand jsonb,
  value   jsonb
)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_boolean boolean;
  v_number numeric;
  v_text text;
begin
  if value is null then
    return null;
  end if;
  if type = 'boolean' then
    v_boolean := "better_supabase"."rule_boolean"(value);
    return case when v_boolean is null then null else v_boolean = coalesce(operand in ('true'::jsonb, '"true"'::jsonb), false) end;
  end if;
  if type = 'number' then
    v_number := "better_supabase"."rule_numeric"(value);
    return case when v_number is null then null else coalesce(v_number = "better_supabase"."rule_numeric"(operand), false) end;
  end if;
  v_text := "better_supabase"."rule_text"(value);
  return case when v_text is null then null else coalesce(v_text = "better_supabase"."rule_text"(operand), false) end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_evaluate (
  conditions jsonb,
  subject    jsonb,
  fields     jsonb,
  time_zone  text                     DEFAULT 'UTC'::text,
  now        timestamp with time zone DEFAULT now()
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_node jsonb := "better_supabase"."rule_node"(conditions, subject, fields, time_zone, now);
begin
  return jsonb_build_object(
    'matched', v_node is null or coalesce((v_node ->> 'truth')::boolean, false),
    'results', coalesce(v_node -> 'results', '{}'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_evaluations_list (
  rule      uuid,
  before    timestamp with time zone DEFAULT NULL::timestamp WITH time zone,
  page_size integer                  DEFAULT 50
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
begin
  select x."tenant_id" into v_tenant from "better_supabase"."automations" x where x."id" = rule_evaluations_list.rule;
  if v_tenant is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'automations.read'), false)) then
    return '[]'::jsonb;
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', y."id"::text, 'organizationId', y."tenant_id", 'ruleId', y."rule_id", 'version', y."version", 'subjectType', y."subject_type", 'subjectId', y."subject_id", 'trigger', y."trigger", 'matched', y."matched", 'results', y."results", 'mode', y."mode", 'evaluatedBy', y."evaluated_by", 'evaluatedAt', y."evaluated_at") order by y."evaluated_at" desc, y."id" desc), '[]'::jsonb)
    from (
      select * from "better_supabase"."automation_evaluations" x
      where x."rule_id" = rule_evaluations_list.rule
        and (rule_evaluations_list.before is null or x."evaluated_at" < rule_evaluations_list.before)
      order by x."evaluated_at" desc, x."id" desc
      limit least(greatest(coalesce(rule_evaluations_list.page_size, 50), 1), 200)
    ) y
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_field_map (
  subject_type text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_object_agg(x."field_id", jsonb_build_object(
    'type', x."type", 'column', x."path", 'columnType', x."column_type",
    'nullable', x."nullable", 'operators', x."operators"
  )), '{}'::jsonb)
  from "better_supabase"."automation_fields" x where x."subject_type" = rule_field_map.subject_type
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_fields_list (
  subject_type text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('subjectType', x."subject_type", 'id', x."field_id", 'label', x."label", 'description', x."description", 'type', x."type", 'column', x."path", 'columnType', x."column_type", 'nullable', x."nullable", 'options', x."options", 'operators', x."operators") order by x."subject_type", x."position"), '[]'::jsonb)
  from "better_supabase"."automation_fields" x
  where rule_fields_list.subject_type is null or x."subject_type" = rule_fields_list.subject_type
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_get (
  id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."automations";
begin
  select * into v_row from "better_supabase"."automations" x where x."id" = rule_get.id;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.read'), false)) then
    return null;
  end if;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_list (
  value jsonb
)
  RETURNS text[]
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_array jsonb := value;
begin
  if jsonb_typeof(value) = 'string' and left(value #>> '{}', 1) = '[' then
    v_array := (value #>> '{}')::jsonb;
  end if;
  if jsonb_typeof(v_array) is distinct from 'array' then
    return null;
  end if;
  return coalesce((
    select array_agg(case jsonb_typeof(e.value) when 'string' then e.value #>> '{}' else e.value::text end order by e.n)
    from jsonb_array_elements(v_array) with ordinality e(value, n)
  ), '{}');
exception when others then
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_matches (
  conditions jsonb,
  subject    jsonb,
  fields     jsonb,
  time_zone  text                     DEFAULT 'UTC'::text,
  now        timestamp with time zone DEFAULT now()
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select ("better_supabase"."rule_evaluate"(conditions, subject, fields, time_zone, now) ->> 'matched')::boolean
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_moment (
  kind  text,
  value jsonb
)
  RETURNS timestamp WITHOUT time zone
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_text text;
begin
  if jsonb_typeof(value) is distinct from 'string' then
    return null;
  end if;
  v_text := value #>> '{}';
  if kind = 'timestamptz' then
    return v_text::timestamptz at time zone 'UTC';
  end if;
  if kind = 'date' then
    return left(v_text, 10)::date::timestamp;
  end if;
  return v_text::timestamp;
exception when others then
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_node (
  node      jsonb,
  subject   jsonb,
  fields    jsonb,
  time_zone text,
  now       timestamp with time zone
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_field jsonb;
  v_value jsonb;
  v_operator text := coalesce(node ->> 'operator', '');
  v_base text;
  v_negative boolean;
  v_truth boolean;
  v_part jsonb;
  v_parts boolean[] := '{}';
  v_results jsonb := '{}'::jsonb;
begin
  if node ->> 'type' = 'rule' then
    v_field := fields -> (
      select string_agg(p.value, '.' order by p.n)
      from jsonb_array_elements_text(coalesce(node -> 'path', '[]'::jsonb)) with ordinality p(value, n)
    );
    if v_operator = '' or v_field is null then
      return null;
    end if;
    v_value := subject #> string_to_array(v_field ->> 'column', '.');
    if jsonb_typeof(v_value) = 'null' then
      v_value := null;
    end if;
    v_base := case v_operator when 'not_empty' then 'empty' when 'not_contains' then 'contains' when 'is_not' then 'is' when 'neq' then 'eq' when 'not_between' then 'between' when 'is_none_of' then 'is_any_of' when 'has_none_of' then 'has_any_of' end;
    v_negative := (v_base is not null) <> coalesce((node ->> 'negated')::boolean, false);
    v_operator := coalesce(v_base, v_operator);
    v_truth := "better_supabase"."rule_positive"(v_field ->> 'type', coalesce(v_field ->> 'columnType', 'text'), v_operator, node -> 'value', v_value, time_zone, now);
    if v_negative then
      -- "is not x" also matches records without a value, except for "is not empty".
      if coalesce((v_field ->> 'nullable')::boolean, true) and v_operator <> 'empty' and v_value is null then
        v_truth := true;
      else
        v_truth := not v_truth;
      end if;
    end if;
    return jsonb_build_object('truth', v_truth, 'results', jsonb_build_object(node ->> 'id', v_truth));
  end if;
  for v_part in
    select "better_supabase"."rule_node"(e.value, subject, fields, time_zone, now)
    from jsonb_array_elements(coalesce(node -> 'rules', '[]'::jsonb)) with ordinality e(value, n)
    order by e.n
  loop
    if v_part is not null then
      v_parts := v_parts || (v_part ->> 'truth')::boolean;
      v_results := v_results || (v_part -> 'results');
    end if;
  end loop;
  if cardinality(v_parts) = 0 then
    return null;
  end if;
  if node ->> 'combinator' = 'and' then
    v_truth := not (false = any (v_parts));
  else
    v_truth := true = any (v_parts);
  end if;
  return jsonb_build_object('truth', v_truth, 'results', v_results || jsonb_build_object(node ->> 'id', v_truth));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_numeric (
  value jsonb
)
  RETURNS numeric
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_text text;
begin
  if jsonb_typeof(value) = 'number' then
    return (value #>> '{}')::numeric;
  end if;
  if jsonb_typeof(value) is distinct from 'string' then
    return null;
  end if;
  v_text := trim(value #>> '{}');
  if v_text = '' or lower(v_text) in ('nan', 'infinity', '+infinity', '-infinity', 'inf', '+inf', '-inf') then
    return null;
  end if;
  return v_text::numeric;
exception when others then
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_positive (
  type      text,
  kind      text,
  operator  text,
  operand   jsonb,
  value     jsonb,
  time_zone text,
  now       timestamp with time zone
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_text text := "better_supabase"."rule_text"(value);
  v_needle text;
  v_value numeric;
  v_low numeric;
  v_high numeric;
  v_list text[];
begin
  case operator
    when 'empty' then
      return value is null or (type = 'text' and value = '""'::jsonb);
    when 'contains', 'starts_with', 'ends_with' then
      if v_text is null then
        return null;
      end if;
      v_needle := lower(coalesce(operand #>> '{}', ''));
      return case operator
        when 'contains' then strpos(lower(v_text), v_needle) > 0
        when 'starts_with' then left(lower(v_text), length(v_needle)) = v_needle
        else right(lower(v_text), length(v_needle)) = v_needle
      end;
    when 'eq' then
      return "better_supabase"."rule_equal"(type, operand, value);
    when 'gt', 'gte', 'lt', 'lte' then
      v_value := "better_supabase"."rule_numeric"(value);
      v_low := "better_supabase"."rule_numeric"(operand);
      if v_value is null or v_low is null then
        return null;
      end if;
      return case operator
        when 'gt' then v_value > v_low
        when 'gte' then v_value >= v_low
        when 'lt' then v_value < v_low
        else v_value <= v_low
      end;
    when 'is_any_of' then
      if value is null then
        return null;
      end if;
      return v_text is not null and jsonb_typeof(operand) = 'array'
        and exists (select 1 from jsonb_array_elements(operand) e where "better_supabase"."rule_text"(e.value) = v_text);
    when 'has_any_of', 'has_all_of' then
      v_list := "better_supabase"."rule_list"(value);
      if v_list is null or jsonb_typeof(operand) is distinct from 'array' then
        return null;
      end if;
      if operator = 'has_any_of' then
        return exists (select 1 from unnest("better_supabase"."rule_list"(operand)) w where w = any (v_list));
      end if;
      return not exists (select 1 from unnest("better_supabase"."rule_list"(operand)) w where not (w = any (v_list)));
    when 'is' then
      if type = 'date' then
        return "better_supabase"."rule_date"(kind, operator, operand, value, time_zone, now);
      end if;
      return "better_supabase"."rule_equal"(type, operand, value);
    when 'between' then
      if type = 'date' then
        return "better_supabase"."rule_date"(kind, operator, operand, value, time_zone, now);
      end if;
      v_value := "better_supabase"."rule_numeric"(value);
      v_low := least("better_supabase"."rule_numeric"(operand -> 0), "better_supabase"."rule_numeric"(operand -> 1));
      v_high := greatest("better_supabase"."rule_numeric"(operand -> 0), "better_supabase"."rule_numeric"(operand -> 1));
      if v_value is null or v_low is null or v_high is null then
        return null;
      end if;
      return v_value >= v_low and v_value <= v_high;
    else
      return "better_supabase"."rule_date"(kind, operator, operand, value, time_zone, now);
  end case;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_text (
  value jsonb
)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case jsonb_typeof(value)
    when 'string' then value #>> '{}'
    when 'number' then value::text
    when 'boolean' then value::text
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rule_versions_list (
  id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
begin
  select x."tenant_id" into v_tenant from "better_supabase"."automations" x where x."id" = rule_versions_list.id;
  if v_tenant is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'automations.read'), false)) then
    return '[]'::jsonb;
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'ruleId', x."rule_id", 'version', x."version", 'name', x."name",
      'conditions', x."conditions", 'actions', x."actions",
      'savedBy', x."saved_by", 'savedAt', x."saved_at"
    ) order by x."version" desc), '[]'::jsonb)
    from "better_supabase"."automation_versions" x where x."rule_id" = rule_versions_list.id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.rules_list (
  tenant       uuid,
  subject_type text    DEFAULT NULL::text,
  trigger      text    DEFAULT NULL::text,
  enabled      boolean DEFAULT NULL::boolean
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', rules_list.tenant, 'automations.read'), false)) then
    raise exception 'You may not read this organization''s rules' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  perform "better_supabase"."install_default_rules"(rules_list.tenant);
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', x."id", 'organizationId', x."tenant_id", 'subjectType', x."subject_type", 'trigger', x."trigger", 'name', x."name", 'description', x."description", 'conditions', x."conditions", 'actions', x."actions", 'enabled', x."enabled", 'stopProcessing', x."stop_processing", 'rank', x."rank", 'version', x."version", 'createdBy', x."created_by", 'updatedBy', x."updated_by", 'createdAt', x."created_at", 'updatedAt', x."updated_at", 'defaultKey', x."default_key") order by x."subject_type", x."trigger", x."rank" collate "C"), '[]'::jsonb)
    from "better_supabase"."automations" x
    where x."tenant_id" = rules_list.tenant
      and (rules_list.subject_type is null or x."subject_type" = rules_list.subject_type)
      and (rules_list.trigger is null or x."trigger" = rules_list.trigger)
      and (rules_list.enabled is null or x."enabled" = rules_list.enabled)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.run_rules (
  tenant       uuid,
  subject_type text,
  trigger      text,
  subject_id   text,
  subject      jsonb,
  time_zone    text  DEFAULT 'UTC'::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_fields jsonb;
  v_rule "better_supabase"."automations";
  v_result jsonb;
  v_matches jsonb := '[]'::jsonb;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role runs rules' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  perform "better_supabase"."install_default_rules"(run_rules.tenant);
  v_fields := "better_supabase"."rule_field_map"(run_rules.subject_type);
  for v_rule in
    select * from "better_supabase"."automations" x
    where x."tenant_id" = run_rules.tenant
      and (run_rules.subject_type is null or x."subject_type" = run_rules.subject_type)
      and x."trigger" = run_rules.trigger and x."enabled"
    order by x."rank" collate "C"
  loop
    if run_rules.subject_type is null then
      v_fields := "better_supabase"."rule_field_map"(v_rule."subject_type");
    end if;
    v_result := "better_supabase"."rule_evaluate"(v_rule."conditions", run_rules.subject, v_fields, coalesce(run_rules.time_zone, 'UTC'), now());
    perform "better_supabase"."record_rule_evaluation"(v_rule."id", run_rules.subject_id, (v_result ->> 'matched')::boolean, v_result -> 'results', 'live');
    if (v_result ->> 'matched')::boolean then
      v_matches := v_matches || jsonb_build_array(jsonb_build_object('rule', jsonb_build_object('id', v_rule."id", 'organizationId', v_rule."tenant_id", 'subjectType', v_rule."subject_type", 'trigger', v_rule."trigger", 'name', v_rule."name", 'description', v_rule."description", 'conditions', v_rule."conditions", 'actions', v_rule."actions", 'enabled', v_rule."enabled", 'stopProcessing', v_rule."stop_processing", 'rank', v_rule."rank", 'version', v_rule."version", 'createdBy', v_rule."created_by", 'updatedBy', v_rule."updated_by", 'createdAt', v_rule."created_at", 'updatedAt', v_rule."updated_at", 'defaultKey', v_rule."default_key"), 'results', v_result -> 'results'));
      exit when v_rule."stop_processing";
    end if;
  end loop;
  return v_matches;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.save_rule (
  tenant uuid,
  rule   jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_id uuid;
  v_old "better_supabase"."automations";
  v_row "better_supabase"."automations";
  v_subject_type text;
  v_trigger text;
  v_name text;
  v_description text;
  v_conditions jsonb;
  v_actions jsonb;
  v_enabled boolean;
  v_stop boolean;
  v_fields jsonb;
  v_action jsonb;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if jsonb_typeof(rule) is distinct from 'object' then
    raise exception 'rule must be an object' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  v_id := nullif(rule ->> 'id', '')::uuid;
  if v_id is not null then
    select * into v_old from "better_supabase"."automations" x where x."id" = v_id and x."tenant_id" = save_rule.tenant for update;
    if v_old."id" is null then
      raise exception 'No rule in this organization has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
    end if;
    if rule ? 'version' and (rule ->> 'version')::integer is distinct from v_old."version" then
      raise exception 'The rule changed since it was read' using errcode = '40001', hint = 'AUTOMATION_CONFLICT';
    end if;
    if rule ? 'subjectType' and rule ->> 'subjectType' is distinct from v_old."subject_type" then
      raise exception 'A rule''s subject type can''t change' using errcode = '22023', hint = 'AUTOMATION_INVALID';
    end if;
  end if;
  v_subject_type := coalesce(v_old."subject_type", rule ->> 'subjectType');
  v_trigger := coalesce(rule ->> 'trigger', v_old."trigger");
  v_name := coalesce(nullif(trim(rule ->> 'name'), ''), v_old."name");
  v_description := case when rule ? 'description' then nullif(trim(rule ->> 'description'), '') else v_old."description" end;
  v_conditions := coalesce(rule -> 'conditions', v_old."conditions", '{"id": "root", "type": "group", "combinator": "and", "rules": []}'::jsonb);
  v_actions := coalesce(rule -> 'actions', v_old."actions", '[]'::jsonb);
  v_enabled := coalesce((rule ->> 'enabled')::boolean, v_old."enabled", false);
  v_stop := coalesce((rule ->> 'stopProcessing')::boolean, v_old."stop_processing", false);
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or (case when (v_enabled or coalesce(v_old."enabled", false)) then coalesce(better_supabase.can('tenant', save_rule.tenant, 'automations.publish'), false) else coalesce(better_supabase.can('tenant', save_rule.tenant, 'automations.write'), false) end)) then
    raise exception 'You need % to save this rule', case when (v_enabled or coalesce(v_old."enabled", false)) then '''automations.publish''' else '''automations.write''' end using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if v_subject_type is null or v_subject_type !~ '^[a-z][a-z0-9_-]{0,62}$' then
    raise exception 'A rule needs a subject type' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if v_trigger is null or length(v_trigger) > 128 or v_trigger !~ '^[a-z][a-z0-9_]*([.:][a-z0-9_]+)*$' then
    raise exception 'A rule needs a trigger such as expense.submitted' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  if v_name is null or length(v_name) > 200 then
    raise exception 'A rule needs a name of at most 200 characters' using errcode = '22023', hint = 'AUTOMATION_INVALID';
  end if;
  v_fields := "better_supabase"."rule_field_map"(v_subject_type);
  if v_fields = '{}'::jsonb and v_old."default_key" is null then
    raise exception 'No rule fields for %; sync them first', v_subject_type using errcode = '22023', hint = 'RULE_SUBJECT_UNKNOWN';
  end if;
  perform "better_supabase"."rule_check"(v_conditions, v_fields, 1);
  if jsonb_typeof(v_actions) is distinct from 'array' or jsonb_array_length(v_actions) > 20 then
    raise exception 'actions must be an array of at most 20 entries' using errcode = '22023', hint = 'AUTOMATION_ACTIONS_INVALID';
  end if;
  for v_action in select x.value from jsonb_array_elements(v_actions) x loop
    if jsonb_typeof(v_action) is distinct from 'object' or v_action ->> 'kind' is null
      or length(v_action ->> 'kind') > 128 or v_action ->> 'kind' !~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$'
      or (v_action ? 'config' and jsonb_typeof(v_action -> 'config') is distinct from 'object') then
      raise exception 'Every action needs a kind such as approvals.request and an optional config object' using errcode = '22023', hint = 'AUTOMATION_ACTIONS_INVALID';
    end if;
  end loop;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_automation_save"(uuid, jsonb)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::jsonb)', v_hook::oid::regproc)
        using save_rule.tenant, save_rule.rule;
    end if;
  end;
  if v_old."id" is null then
    insert into "better_supabase"."automations" ("tenant_id", "subject_type", "trigger", "name", "description", "conditions", "actions", "enabled", "stop_processing", "rank")
    values (save_rule.tenant, v_subject_type, v_trigger, v_name, v_description, v_conditions, v_actions, v_enabled, v_stop,
      case
    when (select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = save_rule.tenant and x."subject_type" = v_subject_type) is null then 'V'
    when length(substring((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = save_rule.tenant and x."subject_type" = v_subject_type) from '^z*')) = length((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = save_rule.tenant and x."subject_type" = v_subject_type)) then (select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = save_rule.tenant and x."subject_type" = v_subject_type) || 'V'
    else left((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = save_rule.tenant and x."subject_type" = v_subject_type), length(substring((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = save_rule.tenant and x."subject_type" = v_subject_type) from '^z*'))) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (strpos('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', substr((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = save_rule.tenant and x."subject_type" = v_subject_type), length(substring((select max(x."rank" collate "C") from "better_supabase"."automations" x where x."tenant_id" = save_rule.tenant and x."subject_type" = v_subject_type) from '^z*')) + 1, 1)) - 1 + 62) / 2 + 1, 1)
  end)
    returning * into v_row;
  elsif v_old."trigger" = v_trigger and v_old."name" = v_name
    and v_old."description" is not distinct from v_description
    and v_old."conditions" = v_conditions and v_old."actions" = v_actions
    and v_old."enabled" = v_enabled and v_old."stop_processing" = v_stop then
    return jsonb_build_object('id', v_old."id", 'organizationId', v_old."tenant_id", 'subjectType', v_old."subject_type", 'trigger', v_old."trigger", 'name', v_old."name", 'description', v_old."description", 'conditions', v_old."conditions", 'actions', v_old."actions", 'enabled', v_old."enabled", 'stopProcessing', v_old."stop_processing", 'rank', v_old."rank", 'version', v_old."version", 'createdBy', v_old."created_by", 'updatedBy', v_old."updated_by", 'createdAt', v_old."created_at", 'updatedAt', v_old."updated_at", 'defaultKey', v_old."default_key");
  else
    update "better_supabase"."automations" x set
      "trigger" = v_trigger,
      "name" = v_name,
      "description" = v_description,
      "conditions" = v_conditions,
      "actions" = v_actions,
      "enabled" = v_enabled,
      "stop_processing" = v_stop,
      "version" = x."version" + 1,
      "updated_by" = auth.uid(),
      "updated_at" = now()
    where x."id" = v_old."id"
    returning * into v_row;
  end if;
  insert into "better_supabase"."automation_versions" ("rule_id", "version", "tenant_id", "name", "conditions", "actions", "saved_by")
  values (v_row."id", v_row."version", v_row."tenant_id", v_row."name", v_row."conditions", v_row."actions", auth.uid())
  on conflict do nothing;
  if v_old."id" is null then
    perform better_supabase.audit_event(
    event_type => 'automation.created',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  else
    perform better_supabase.audit_event(
    event_type => 'automation.updated',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  end if;
  if v_row."enabled" and not coalesce(v_old."enabled", false) then
    perform better_supabase.audit_event(
    event_type => 'automation.enabled',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  elsif not v_row."enabled" and coalesce(v_old."enabled", false) then
    perform better_supabase.audit_event(
    event_type => 'automation.disabled',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_automation_save"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using v_row."id";
    end if;
  end;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_delete_group (
  tenant uuid,
  id     uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  v_members uuid[];
  v_member uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  select coalesce(array_agg(sm."scim_user_id"), '{}') into v_members
  from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" x on x."id" = sm."group_id"
  where x."tenant_id" = scim_delete_group.tenant and x."id" = scim_delete_group.id;
  delete from "better_supabase"."scim_groups" x where x."tenant_id" = scim_delete_group.tenant and x."id" = scim_delete_group.id;
  if not found then
    return false;
  end if;
  foreach v_member in array v_members loop
    perform "better_supabase"."scim_sync_member"(v_member);
  end loop;
  perform better_supabase.audit_event(
    event_type => 'scim_group.deleted',
    category => 'security',
    target_type => 'scim_group',
    record_id => scim_delete_group.id::text,
    tenant => (scim_delete_group.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_delete_group.tenant::text, 'scimGroupId', scim_delete_group.id)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_delete_user (
  tenant uuid,
  id     uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  v_id uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  update "better_supabase"."scim_users" x set "active" = false
  where x."tenant_id" = scim_delete_user.tenant and x."id" = scim_delete_user.id
  returning x."id" into v_id;
  if v_id is null then
    return false;
  end if;
  perform "better_supabase"."scim_sync_member"(v_id);
  delete from "better_supabase"."scim_users" x where x."id" = v_id;
  perform better_supabase.audit_event(
    event_type => 'scim_user.deleted',
    category => 'security',
    target_type => 'scim_user',
    record_id => v_id::text,
    tenant => (scim_delete_user.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_delete_user.tenant::text, 'scimUserId', v_id)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_get_group (
  tenant uuid,
  id     uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select to_jsonb(x.*) || jsonb_build_object('members', (
      select coalesce(jsonb_agg(jsonb_build_object('value', su."id", 'display', coalesce(su."display_name", su."user_name")) order by su."user_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_users" su on su."id" = sm."scim_user_id"
      where sm."group_id" = x."id"
    )) from "better_supabase"."scim_groups" x
    where x."tenant_id" = scim_get_group.tenant and x."id" = scim_get_group.id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_get_user (
  tenant uuid,
  id     uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select to_jsonb(x.*) || jsonb_build_object('groups', (
      select coalesce(jsonb_agg(jsonb_build_object('value', sg."id", 'display', sg."display_name") order by sg."display_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" sg on sg."id" = sm."group_id"
      where sm."scim_user_id" = x."id"
    )) from "better_supabase"."scim_users" x
    where x."tenant_id" = scim_get_user.tenant and x."id" = scim_get_user.id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_group_role (
  display_name text
)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select coalesce(
    (select t.role from (select null::text as name, null::text as role where false) as t(name, role) where t.name = lower(scim_group_role.display_name)),
    case when lower(scim_group_role.display_name) = any (array['admin', 'member']::text[]) then lower(scim_group_role.display_name) end
  )
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_list_groups (
  tenant uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(x.*) || jsonb_build_object('members', (
      select coalesce(jsonb_agg(jsonb_build_object('value', su."id", 'display', coalesce(su."display_name", su."user_name")) order by su."user_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_users" su on su."id" = sm."scim_user_id"
      where sm."group_id" = x."id"
    )) order by x."created_at", x."id"), '[]'::jsonb)
    from "better_supabase"."scim_groups" x where x."tenant_id" = scim_list_groups.tenant
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_list_users (
  tenant uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(x.*) || jsonb_build_object('groups', (
      select coalesce(jsonb_agg(jsonb_build_object('value', sg."id", 'display', sg."display_name") order by sg."display_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" sg on sg."id" = sm."group_id"
      where sm."scim_user_id" = x."id"
    )) order by x."created_at", x."id"), '[]'::jsonb)
    from "better_supabase"."scim_users" x where x."tenant_id" = scim_list_users.tenant
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_save_group (
  tenant  uuid,
  id      uuid,
  data    jsonb,
  version integer DEFAULT NULL::integer
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."scim_groups";
  v_name text := scim_save_group.data ->> 'displayName';
  v_members uuid[];
  v_before uuid[] := '{}';
  v_member uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_name is null or length(trim(v_name)) = 0 then
    raise exception 'displayName is required' using errcode = '22023', hint = 'SCIM_INVALID';
  end if;
  begin
    select coalesce(array_agg(distinct (w.value)::uuid), '{}') into v_members
    from jsonb_array_elements_text(coalesce(scim_save_group.data -> 'members', '[]'::jsonb)) w;
  exception when invalid_text_representation then
    raise exception 'members must be SCIM user ids' using errcode = '22023', hint = 'SCIM_INVALID';
  end;
  if exists (
    select 1 from unnest(v_members) w(member)
    where not exists (select 1 from "better_supabase"."scim_users" x where x."tenant_id" = scim_save_group.tenant and x."id" = w.member)
  ) then
    raise exception 'members must be SCIM users of the organization' using errcode = '22023', hint = 'SCIM_INVALID';
  end if;
  if scim_save_group.id is null then
    insert into "better_supabase"."scim_groups" ("tenant_id", "display_name", "external_id", "role")
    values (scim_save_group.tenant, v_name, scim_save_group.data ->> 'externalId', "better_supabase"."scim_group_role"(v_name))
    returning * into v_row;
  else
    select * into v_row from "better_supabase"."scim_groups" x where x."tenant_id" = scim_save_group.tenant and x."id" = scim_save_group.id for update;
    if v_row."id" is null then
      raise exception 'No SCIM group has this id' using errcode = 'P0002', hint = 'SCIM_NOT_FOUND';
    end if;
    if scim_save_group.version is not null and scim_save_group.version <> v_row."version" then
      raise exception 'The group changed since version %', scim_save_group.version using errcode = 'P0001', hint = 'SCIM_PRECONDITION';
    end if;
    select coalesce(array_agg(sm."scim_user_id"), '{}') into v_before from "better_supabase"."scim_group_members" sm where sm."group_id" = v_row."id";
    update "better_supabase"."scim_groups" x set
      "display_name" = v_name,
      "external_id" = scim_save_group.data ->> 'externalId',
      "role" = "better_supabase"."scim_group_role"(v_name),
      "version" = x."version" + 1,
      "updated_at" = now()
    where x."id" = v_row."id"
    returning * into v_row;
    delete from "better_supabase"."scim_group_members" sm where sm."group_id" = v_row."id" and not (sm."scim_user_id" = any (v_members));
  end if;
  insert into "better_supabase"."scim_group_members" ("group_id", "scim_user_id")
  select v_row."id", w.member from unnest(v_members) w(member)
  on conflict do nothing;
  for v_member in select distinct w.member from unnest(v_before || v_members) w(member) loop
    perform "better_supabase"."scim_sync_member"(v_member);
  end loop;
  if scim_save_group.id is null then
    perform better_supabase.audit_event(
    event_type => 'scim_group.created',
    category => 'security',
    target_type => 'scim_group',
    record_id => v_row."id"::text,
    tenant => (scim_save_group.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_save_group.tenant::text, 'scimGroupId', v_row."id")
  );
  else
    perform better_supabase.audit_event(
    event_type => 'scim_group.updated',
    category => 'security',
    target_type => 'scim_group',
    record_id => v_row."id"::text,
    tenant => (scim_save_group.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_save_group.tenant::text, 'scimGroupId', v_row."id")
  );
  end if;
  return (select to_jsonb(x.*) || jsonb_build_object('members', (
      select coalesce(jsonb_agg(jsonb_build_object('value', su."id", 'display', coalesce(su."display_name", su."user_name")) order by su."user_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_users" su on su."id" = sm."scim_user_id"
      where sm."group_id" = x."id"
    )) from "better_supabase"."scim_groups" x where x."id" = v_row."id");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_save_user (
  tenant  uuid,
  id      uuid,
  data    jsonb,
  version integer DEFAULT NULL::integer
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."scim_users";
  v_emails jsonb := coalesce(scim_save_user.data -> 'emails', '[]'::jsonb);
  v_name text := scim_save_user.data ->> 'userName';
  v_email text;
  v_user uuid;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role serves SCIM' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  if v_name is null or length(trim(v_name)) = 0 then
    raise exception 'userName is required' using errcode = '22023', hint = 'SCIM_INVALID';
  end if;
  if jsonb_typeof(v_emails) <> 'array' then
    raise exception 'emails must be an array' using errcode = '22023', hint = 'SCIM_INVALID';
  end if;
  v_email := lower(coalesce(
    (select e ->> 'value' from jsonb_array_elements(v_emails) e where (e ->> 'primary')::boolean limit 1),
    v_emails -> 0 ->> 'value',
    case when v_name like '%@%' then v_name end
  ));
  if scim_save_user.id is null then
    insert into "better_supabase"."scim_users" ("tenant_id", "external_id", "user_name", "display_name", "given_name", "family_name", "email", "emails", "active")
    values (scim_save_user.tenant, scim_save_user.data ->> 'externalId', v_name, scim_save_user.data ->> 'displayName',
      scim_save_user.data ->> 'givenName', scim_save_user.data ->> 'familyName', v_email, v_emails,
      coalesce((scim_save_user.data ->> 'active')::boolean, true))
    returning * into v_row;
  else
    select * into v_row from "better_supabase"."scim_users" x where x."tenant_id" = scim_save_user.tenant and x."id" = scim_save_user.id for update;
    if v_row."id" is null then
      raise exception 'No SCIM user has this id' using errcode = 'P0002', hint = 'SCIM_NOT_FOUND';
    end if;
    if scim_save_user.version is not null and scim_save_user.version <> v_row."version" then
      raise exception 'The user changed since version %', scim_save_user.version using errcode = 'P0001', hint = 'SCIM_PRECONDITION';
    end if;
    update "better_supabase"."scim_users" x set
      "external_id" = scim_save_user.data ->> 'externalId',
      "user_name" = v_name,
      "display_name" = scim_save_user.data ->> 'displayName',
      "given_name" = scim_save_user.data ->> 'givenName',
      "family_name" = scim_save_user.data ->> 'familyName',
      "email" = v_email,
      "emails" = v_emails,
      "active" = coalesce((scim_save_user.data ->> 'active')::boolean, true),
      "version" = x."version" + 1,
      "updated_at" = now()
    where x."id" = v_row."id"
    returning * into v_row;
  end if;
  if v_row."user_id" is null and v_email is not null and exists (select 1 from "better_supabase"."sso_domains" vd where vd."tenant_id" = scim_save_user.tenant and vd."verified_at" is not null and vd."domain" = lower(split_part(v_email, '@', 2))) then
    select au.id into v_user from auth.users au
    where lower(au.email) = v_email and au.email_confirmed_at is not null
      and not exists (select 1 from "better_supabase"."scim_users" y where y."tenant_id" = scim_save_user.tenant and y."user_id" = au.id)
    limit 1;
    if v_user is not null then
      update "better_supabase"."scim_users" x set "user_id" = v_user where x."id" = v_row."id" returning * into v_row;
    end if;
  end if;
  perform "better_supabase"."scim_sync_member"(v_row."id");
  if scim_save_user.id is null then
    perform better_supabase.audit_event(
    event_type => 'scim_user.created',
    category => 'security',
    target_type => 'scim_user',
    record_id => v_row."id"::text,
    tenant => (scim_save_user.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_save_user.tenant::text, 'scimUserId', v_row."id")
  );
  else
    perform better_supabase.audit_event(
    event_type => 'scim_user.updated',
    category => 'security',
    target_type => 'scim_user',
    record_id => v_row."id"::text,
    tenant => (scim_save_user.tenant)::uuid,
    metadata => jsonb_build_object('organizationId', scim_save_user.tenant::text, 'scimUserId', v_row."id")
  );
  end if;
  return (select to_jsonb(x.*) || jsonb_build_object('groups', (
      select coalesce(jsonb_agg(jsonb_build_object('value', sg."id", 'display', sg."display_name") order by sg."display_name"), '[]'::jsonb)
      from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" sg on sg."id" = sm."group_id"
      where sm."scim_user_id" = x."id"
    )) from "better_supabase"."scim_users" x where x."id" = v_row."id");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scim_sync_member (
  scim_user uuid
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."scim_users";
  v_tenant uuid;
  v_user uuid;
  v_current text;
  v_role text;
begin
  select * into v_row from "better_supabase"."scim_users" x where x."id" = scim_sync_member.scim_user;
  if v_row."user_id" is null then
    return;
  end if;
  v_tenant := v_row."tenant_id";
  v_user := v_row."user_id";
  select mm."role" into v_current from "public"."organization_memberships" mm where mm."organization_id" = v_tenant and mm."user_id" = v_user;
  if v_current = 'owner' then
    return;
  end if;
  if not v_row."active" then
    delete from "public"."organization_memberships" mm where mm."organization_id" = v_tenant and mm."user_id" = v_user;
    if found then
      perform better_supabase.audit_event(
    event_type => 'organization.member_removed',
    category => 'membership',
    target_type => 'user',
    record_id => v_user::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant::text, 'userId', v_user)
  );
    end if;
    return;
  end if;
  select coalesce((
    select sg."role" from "better_supabase"."scim_group_members" sm join "better_supabase"."scim_groups" sg on sg."id" = sm."group_id"
    where sm."scim_user_id" = v_row."id" and sg."role" is not null
    order by array_position(array['admin', 'member']::text[], sg."role")
    limit 1
  ), 'member') into v_role;
  if v_current is null then
    insert into "public"."organization_memberships" ("organization_id", "user_id", "role") values (v_tenant, v_user, v_role);
    perform better_supabase.audit_event(
    event_type => 'organization.member_added',
    category => 'membership',
    target_type => 'user',
    record_id => v_user::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant::text, 'userId', v_user, 'role', v_role)
  );
  elsif v_current is distinct from v_role then
    update "public"."organization_memberships" mm set "role" = v_role where mm."organization_id" = v_tenant and mm."user_id" = v_user;
    perform better_supabase.audit_event(
    event_type => 'organization.role_changed',
    category => 'membership',
    target_type => 'user',
    record_id => v_user::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant::text, 'userId', v_user, 'role', v_role, 'previousRole', v_current)
  );
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.scope_permissions (
  scope text
)
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case scope
    when 'access_requests:create' then array['access_requests.create']::text[]
    when 'access_requests:emergency' then array['access_requests.emergency']::text[]
    when 'access_requests:manage' then array['access_requests.manage']::text[]
    when 'access_requests:read' then array['access_requests.read']::text[]
    when 'access_requests:review' then array['access_requests.review']::text[]
    when 'api_keys:manage' then array['api_keys.manage']::text[]
    when 'api_keys:own' then array['api_keys.own']::text[]
    when 'approvals:manage' then array['approvals.manage']::text[]
    when 'approvals:read' then array['approvals.read']::text[]
    when 'approvals:request' then array['approvals.request']::text[]
    when 'audit:read' then array['audit.read']::text[]
    when 'audit:revert' then array['audit.revert']::text[]
    when 'automations:manage' then array['automations.manage']::text[]
    when 'automations:publish' then array['automations.publish']::text[]
    when 'automations:read' then array['automations.read']::text[]
    when 'automations:write' then array['automations.write']::text[]
    when 'billing:read' then array['billing.read']::text[]
    when 'impersonation:read' then array['impersonation.read']::text[]
    when 'impersonation:revoke' then array['impersonation.revoke']::text[]
    when 'impersonation:start' then array['impersonation.start']::text[]
    when 'members:invite' then array['members.invite']::text[]
    when 'members:read' then array['members.read']::text[]
    when 'members:remove' then array['members.remove']::text[]
    when 'members:update_role' then array['members.update_role']::text[]
    when 'organization:delete' then array['organization.delete']::text[]
    when 'organization:transfer_ownership' then array['organization.transfer_ownership']::text[]
    when 'organization:update' then array['organization.update']::text[]
    when 'quotes:approve' then array['quotes.approve']::text[]
    when 'quotes:create' then array['quotes.create']::text[]
    when 'quotes:delete' then array['quotes.delete']::text[]
    when 'quotes:list' then array['quotes.list']::text[]
    when 'quotes:read' then array['quotes.read']::text[]
    when 'quotes:send' then array['quotes.send']::text[]
    when 'quotes:update' then array['quotes.update']::text[]
    when 'relations:manage' then array['relations.manage']::text[]
    when 'relations:read' then array['relations.read']::text[]
    when 'roles:manage' then array['roles.manage']::text[]
    when 'service_accounts:manage' then array['service_accounts.manage']::text[]
    when 'service_accounts:read' then array['service_accounts.read']::text[]
    when 'settings:manage' then array['settings.manage']::text[]
    when 'settings:read' then array['settings.read']::text[]
    when 'settings:update' then array['settings.update']::text[]
    when 'sso:manage' then array['sso.manage']::text[]
    when 'staff:list' then array['staff.list']::text[]
    when 'staff:read' then array['staff.read']::text[]
    when 'teams:manage' then array['teams.manage']::text[]
    when 'teams:read' then array['teams.read']::text[]
    when 'usage:read' then array['usage.read']::text[]
    when 'usage:record' then array['usage.record']::text[]
    else array[scope]
  end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.seed_tenant_defaults (
  p_tenant   uuid,
  p_variants jsonb DEFAULT '{}'::jsonb,
  p_locale   text  DEFAULT 'en'::text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  null;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.service_principals_list (
  tenant uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p."id", 'name', p."name", 'role', p."role", 'isDefault', p."is_default",
    'createdBy', p."created_by", 'createdAt', p."created_at", 'disabledAt', p."disabled_at"
  ) order by p."name"), '[]'::jsonb)
  from "better_supabase"."service_principals" p
  where p."tenant_id" = service_principals_list.tenant
$function$;

CREATE OR REPLACE FUNCTION better_supabase.session_active()
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  claims jsonb := auth.jwt();
  session text := claims ->> 'session_id';
begin
  if claims -> 'act' is not null or session is null then
    return true;
  end if;
  if session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = session::uuid
      and s.user_id = (claims ->> 'sub')::uuid
      and (s.not_after is null or s.not_after > now())
      and (u.banned_until is null or u.banned_until <= now())
      and u.deleted_at is null
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.session_end_reason()
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if exists (
    select 1 from auth.users u
    where u.id = auth.uid() and u.banned_until is not null and u.banned_until > now()
  ) then
    return 'user_banned';
  end if;
  return 'session_not_found';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.sessions_overview()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'count', jsonb_array_length(s.payload),
    'currentId', (select x ->> 'id' from jsonb_array_elements(s.payload) x where (x ->> 'current')::boolean limit 1),
    'sessions', s.payload)
  from (select better_supabase.list_my_sessions() as payload) s
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_organization_setting (
  tenant uuid,
  key    text,
  value  jsonb
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  insert into "better_supabase"."organization_settings" ("tenant_id", "key", "value", "updated_by", "updated_at")
  values (set_organization_setting.tenant, set_organization_setting.key, coalesce(set_organization_setting.value -> 'value', 'null'::jsonb), auth.uid(), now())
  on conflict ("tenant_id", "key") do update
    set "value" = excluded."value", "updated_by" = auth.uid(), "updated_at" = now()
  returning "value"
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_platform_setting (
  key   text,
  value jsonb
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  insert into "better_supabase"."platform_settings" ("key", "value", "updated_by", "updated_at")
  values (set_platform_setting.key, coalesce(set_platform_setting.value -> 'value', 'null'::jsonb), auth.uid(), now())
  on conflict ("key") do update
    set "value" = excluded."value", "updated_by" = auth.uid(), "updated_at" = now()
  returning "value"
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_rule_enabled (
  id      uuid,
  enabled boolean
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."automations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."automations" x where x."id" = set_rule_enabled.id for update;
  if v_row."id" is null or not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.read'), false)) then
    raise exception 'No rule you can read has this id' using errcode = 'P0002', hint = 'AUTOMATION_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_row."tenant_id", 'automations.publish'), false)) then
    raise exception 'Publishing rules needs the publish permission' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if v_row."enabled" = coalesce(set_rule_enabled.enabled, false) then
    return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
  end if;
  update "better_supabase"."automations" x set "enabled" = coalesce(set_rule_enabled.enabled, false), "updated_by" = auth.uid(), "updated_at" = now()
  where x."id" = v_row."id" returning * into v_row;
  if v_row."enabled" then
    perform better_supabase.audit_event(
    event_type => 'automation.enabled',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  else
    perform better_supabase.audit_event(
    event_type => 'automation.disabled',
    category => 'configuration',
    target_type => 'rule',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'ruleId', v_row."id"::text, 'name', v_row."name", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'version', v_row."version"),
    actor_id => auth.uid()
  );
  end if;
  return jsonb_build_object('id', v_row."id", 'organizationId', v_row."tenant_id", 'subjectType', v_row."subject_type", 'trigger', v_row."trigger", 'name', v_row."name", 'description', v_row."description", 'conditions', v_row."conditions", 'actions', v_row."actions", 'enabled', v_row."enabled", 'stopProcessing', v_row."stop_processing", 'rank', v_row."rank", 'version', v_row."version", 'createdBy', v_row."created_by", 'updatedBy', v_row."updated_by", 'createdAt', v_row."created_at", 'updatedAt', v_row."updated_at", 'defaultKey', v_row."default_key");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_service_principal_role (
  principal  uuid,
  role       text,
  created_by uuid DEFAULT NULL::uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_row "better_supabase"."service_principals";
begin
  select * into v_row from "better_supabase"."service_principals" p where p."id" = set_service_principal_role.principal and p."disabled_at" is null for update;
  if not found then
    raise exception 'No such service principal' using errcode = 'P0002', hint = 'SERVICE_PRINCIPAL_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Service principals are managed by the service' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  if set_service_principal_role.created_by is not null and not (
    coalesce(better_supabase.member_can(set_service_principal_role.created_by, v_row."tenant_id", 'service_accounts.manage'), false)
    and coalesce(better_supabase.can_assign_as(set_service_principal_role.created_by, v_row."tenant_id", set_service_principal_role.role), false)
  ) then
    raise exception 'You may not manage service principals with this role' using errcode = '42501', hint = 'SERVICE_PRINCIPAL_FORBIDDEN';
  end if;
  update "better_supabase"."service_principals" set "role" = set_service_principal_role.role where "id" = v_row."id";
  update "public"."organization_memberships" set "role" = set_service_principal_role.role
  where "organization_id" = v_row."tenant_id" and "user_id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'service_principal.role_changed',
    category => 'access',
    target_type => 'service_principal',
    record_id => v_row."id"::text,
    target_label => v_row."name",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'id', v_row."id", 'role', set_service_principal_role.role),
    actor_id => coalesce(set_service_principal_role.created_by, auth.uid())
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_ssf_stream_status (
  id     uuid,
  status text,
  reason text DEFAULT NULL::text
)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."ssf_streams";
  v_previous text;
  v_held record;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  if set_ssf_stream_status.status not in ('enabled', 'paused', 'disabled') then
    raise exception 'status is enabled, paused or disabled' using errcode = '22023', hint = 'SECURITY_EVENT_STATUS_INVALID';
  end if;
  select s."status" into v_previous from "better_supabase"."ssf_streams" s where s."id" = set_ssf_stream_status.id for update;
  if not found then
    raise exception 'stream not found' using errcode = 'P0002', hint = 'SECURITY_EVENT_STREAM_NOT_FOUND';
  end if;
  update "better_supabase"."ssf_streams" s set "status" = set_ssf_stream_status.status, "reason" = set_ssf_stream_status.reason
  where s."id" = set_ssf_stream_status.id
  returning s.* into v_row;
  if v_row."status" = 'disabled' then
    delete from "better_supabase"."ssf_events" q where q."stream_id" = v_row."id";
  elsif v_row."status" = 'enabled' and v_row."delivery_method" = 'urn:ietf:rfc:8935' and false then
    for v_held in
      select q."jti" as jti, q."token" as token from "better_supabase"."ssf_events" q
      where q."stream_id" = v_row."id" order by q."created_at"
    loop
      null;
    end loop;
    delete from "better_supabase"."ssf_events" q where q."stream_id" = v_row."id";
  end if;
  if v_previous is distinct from v_row."status" then
    perform better_supabase.audit_event(
    event_type => 'ssf_stream.status_changed',
    category => 'security',
    target_type => 'ssf_stream',
    record_id => v_row."id"::text,
    metadata => jsonb_build_object('streamId', v_row."id", 'receiver', v_row."receiver", 'tenant', v_row."tenant", 'status', v_row."status", 'reason', v_row."reason")
  );
  end if;
  return v_previous;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_usage_quota (
  tenant      uuid,
  plan        text,
  meter       text,
  quota_limit numeric,
  period      text    DEFAULT 'month'::text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  changed integer;
begin
  if (tenant is null) = (plan is null) then
    raise exception 'set_usage_quota needs a tenant or a plan, not both' using errcode = '22023', hint = 'USAGE_QUOTA_TARGET';
  end if;
  update "better_supabase"."usage_quotas" q
  set "limit" = quota_limit, "period" = coalesce(period, 'month')
  where q."meter" = meter
    and q."tenant_id" is not distinct from tenant
    and q."plan" is not distinct from plan;
  if not found then
    insert into "better_supabase"."usage_quotas" ("tenant_id", "plan", "meter", "limit", "period")
    values (tenant, plan, meter, quota_limit, coalesce(period, 'month'));
  end if;
end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.set_user_setting (
  key   text,
  value jsonb
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  insert into "better_supabase"."user_settings" ("user_id", "key", "value", "updated_by", "updated_at")
  values (auth.uid(), set_user_setting.key, coalesce(set_user_setting.value -> 'value', 'null'::jsonb), auth.uid(), now())
  on conflict ("user_id", "key") do update
    set "value" = excluded."value", "updated_by" = auth.uid(), "updated_at" = now()
  returning "value"
$function$;

CREATE OR REPLACE FUNCTION better_supabase.settle_approval (
  request_id uuid,
  outcome    text,
  reason     text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_req "better_supabase"."approval_requests"%rowtype;
begin
  if settle_approval.outcome not in ('approved', 'rejected') then
    raise exception 'outcome must be approved or rejected' using errcode = '22023', hint = 'APPROVAL_DECISION_INVALID';
  end if;
  select * into v_req from "better_supabase"."approval_requests" r where r."id" = settle_approval.request_id for update;
  if not found then
    raise exception 'approval request not found' using errcode = 'P0002', hint = 'APPROVAL_NOT_FOUND';
  end if;
  if v_req."status" <> 'pending' then
    raise exception 'this request is no longer pending' using errcode = '22023', hint = 'APPROVAL_CLOSED';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", settle_approval.outcome;
    end if;
  end;
  update "better_supabase"."approval_items" x set "status" = settle_approval.outcome, "decided_at" = now()
  where x."request_id" = v_req."id" and x."status" = 'pending';
  insert into "better_supabase"."approval_decisions" ("request_id", "tenant_id", "step", "approver", "decision", "comment")
  values (v_req."id", v_req."tenant_id", v_req."step", null, settle_approval.outcome, left('system' || coalesce(': ' || settle_approval.reason, ''), 2000));
  update "better_supabase"."approval_requests" r set "status" = settle_approval.outcome, "decided_at" = now()
    where r."id" = v_req."id" returning * into v_req;
  if settle_approval.outcome = 'approved' then
    perform "better_supabase"."approval_finalize"(v_req."id");
  else
    perform better_supabase.audit_event(
    event_type => 'approval.rejected',
    category => 'data',
    target_type => 'approval_request',
    record_id => v_req."id"::text,
    summary => 'rejected' || ' ' || v_req."action" || ' on ' || v_req."subject_type" || ' ' || v_req."subject_id",
    tenant => (v_req."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_req."tenant_id"::text, 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'id', v_req."id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step")
  );
    perform "better_supabase"."approval_notify"(v_req."id", 'rejected');
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_approval_decide"(uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::text)', v_hook::oid::regproc)
        using v_req."id", v_req."status";
    end if;
  end;
  return jsonb_build_object('id', v_req."id", 'organizationId', v_req."tenant_id", 'subjectType', v_req."subject_type", 'subjectId', v_req."subject_id", 'action', v_req."action", 'status', v_req."status", 'step', v_req."step", 'steps', v_req."policy" -> 'steps', 'requestedBy', v_req."requested_by", 'reason', v_req."reason", 'payload', v_req."payload", 'expiresAt', v_req."expires_at", 'decidedAt', v_req."decided_at", 'mode', coalesce(v_req."policy" ->> 'mode', 'authorize'), 'fingerprint', v_req."fingerprint", 'consumedAt', v_req."consumed_at", 'createdAt', v_req."created_at") || jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('id', x."id", 'key', x."key", 'label', x."label", 'payload', x."payload", 'permission', x."permission", 'dependsOn', to_jsonb(x."depends_on"), 'status', x."status", 'createdType', x."created_type", 'createdId', x."created_id", 'decidedBy', x."decided_by", 'decidedAt', x."decided_at", 'createdAt', x."created_at") order by x."created_at", x."key")
      from "better_supabase"."approval_items" x where x."request_id" = v_req."id"
    ), '[]'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.sole_owned_organizations (
  member       uuid DEFAULT NULL::uuid,
  organization uuid DEFAULT NULL::uuid
)
  RETURNS uuid[]
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  v_member uuid := coalesce(member, auth.uid());
  v_all boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or v_member = auth.uid();
  v_ids uuid[];
begin
  if v_member is null then
    raise exception 'Only the member or the service role can read this' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if not v_all and (case when organization is null then not exists (select 1 from "public"."organization_memberships" m
    where m."user_id" = v_member
      and coalesce(better_supabase.member_can(auth.uid(), m."organization_id", 'members.remove'), false)) else not coalesce(better_supabase.member_can(auth.uid(), organization, 'members.remove'), false) end) then
    raise exception 'Not allowed to read this member''s organizations' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  v_ids := coalesce((
    select array_agg(m."organization_id" order by m."organization_id")
    from "public"."organization_memberships" m
    where m."user_id" = v_member and m."role" = 'owner'
      and (organization is null or m."organization_id" = organization)
      and exists (select 1 from "better_supabase"."organizations" o where o."id" = m."organization_id")
      and not exists (
        select 1 from "public"."organization_memberships" y
        where y."organization_id" = m."organization_id" and y."user_id" <> v_member and y."role" = 'owner'
      )
  ), '{}');
  if not v_all and exists (
    select 1 from unnest(v_ids) t (id)
    where not coalesce(better_supabase.member_can(auth.uid(), t.id, 'members.remove'), false)
  ) then
    raise exception 'Not allowed to read this member''s organizations' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  return v_ids;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.ssf_stream (
  id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  return (select jsonb_build_object(
    'id', s."id",
    'tenant', s."tenant",
    'receiver', s."receiver",
    'audience', to_jsonb(s."audience"),
    'description', s."description",
    'eventsRequested', to_jsonb(s."events_requested"),
    'eventsDelivered', to_jsonb(s."events_delivered"),
    'method', s."delivery_method",
    'endpointUrl', null::text,
    'status', s."status",
    'reason', s."reason",
    'createdAt', s."created_at",
    'updatedAt', s."updated_at"
  ) from "better_supabase"."ssf_streams" s where s."id" = ssf_stream.id);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.ssf_streams (
  receiver text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
    'id', s."id",
    'tenant', s."tenant",
    'receiver', s."receiver",
    'audience', to_jsonb(s."audience"),
    'description', s."description",
    'eventsRequested', to_jsonb(s."events_requested"),
    'eventsDelivered', to_jsonb(s."events_delivered"),
    'method', s."delivery_method",
    'endpointUrl', null::text,
    'status', s."status",
    'reason', s."reason",
    'createdAt', s."created_at",
    'updatedAt', s."updated_at"
  ) order by s."created_at")
    from "better_supabase"."ssf_streams" s where s."receiver" = ssf_streams.receiver
  ), '[]'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.ssf_streams_for_event (
  tenant     text,
  event_type text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s."id", 'audience', to_jsonb(s."audience")) order by s."created_at")
    from "better_supabase"."ssf_streams" s
    where s."status" <> 'disabled'
      and ssf_streams_for_event.event_type = any (s."events_delivered")
      and (s."tenant" is null or s."tenant" = ssf_streams_for_event.tenant)
  ), '[]'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.sso_access_token_check (
  event jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_email text;
begin
  select au.email into v_email from auth.users au where au.id = (sso_access_token_check.event ->> 'user_id')::uuid;
  if v_email is null or not exists (
    select 1 from "better_supabase"."sso_domains" x
    where x."verified_at" is not null and x."enforce_sso" and x."domain" = lower(split_part(v_email, '@', 2))
  ) then
    return sso_access_token_check.event;
  end if;
  if sso_access_token_check.event ->> 'authentication_method' = 'sso/saml'
    or exists (
      select 1 from jsonb_array_elements(coalesce(sso_access_token_check.event -> 'claims' -> 'amr', '[]'::jsonb)) a(entry)
      where a.entry ->> 'method' = 'sso/saml'
    ) then
    return sso_access_token_check.event;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Sign in with your organization''s single sign-on'
  ));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.sso_domain_for (
  email text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'domain', x."domain",
    'organizationId', x."tenant_id"::text,
    'providerId', sp."id",
    'enforceSso', x."enforce_sso"
  )
  from "better_supabase"."sso_domains" x
  join "better_supabase"."sso_providers" sp on sp."tenant_id" = x."tenant_id" and x."domain" = any (sp."domains")
  where x."verified_at" is not null
    and x."domain" = lower(split_part(sso_domain_for.email, '@', 2))
  limit 1
$function$;

CREATE OR REPLACE FUNCTION better_supabase.sso_on_auth_user()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_scim record;
  v_join record;
  v_tenant uuid;
  v_user uuid := new.id;
begin
  if new.email is null or new.email_confirmed_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.email is not distinct from new.email and old.email_confirmed_at is not null then
    return new;
  end if;
  begin
    for v_scim in
      update "better_supabase"."scim_users" x set "user_id" = new.id
      where x."user_id" is null and x."email" = lower(new.email)
        and exists (select 1 from "better_supabase"."sso_domains" vd where vd."tenant_id" = x."tenant_id" and vd."verified_at" is not null and vd."domain" = lower(split_part(new.email, '@', 2)))
        and not exists (select 1 from "better_supabase"."scim_users" y where y."tenant_id" = x."tenant_id" and y."user_id" = new.id)
      returning x."id" as id
    loop
      perform "better_supabase"."scim_sync_member"(v_scim.id);
    end loop;
    for v_join in
      select x."tenant_id" as tenant, x."auto_join_role" as role from "better_supabase"."sso_domains" x
      where x."verified_at" is not null and x."auto_join_role" is not null
        and x."domain" = lower(split_part(new.email, '@', 2))
        and not exists (select 1 from "better_supabase"."scim_users" y where y."tenant_id" = x."tenant_id" and y."user_id" = new.id)
        and not exists (select 1 from "public"."organization_memberships" mm where mm."organization_id" = x."tenant_id" and mm."user_id" = new.id)
    loop
      v_tenant := v_join.tenant;
      insert into "public"."organization_memberships" ("organization_id", "user_id", "role") values (v_tenant, v_user, v_join.role);
      perform better_supabase.audit_event(
    event_type => 'organization.member_added',
    category => 'membership',
    target_type => 'user',
    record_id => v_user::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant::text, 'userId', v_user, 'role', v_join.role)
  );
    end loop;
  exception when others then
    raise warning 'SSO membership for user % failed: % (SQLSTATE %)', new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.sso_provider (
  provider uuid,
  actor    uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."sso_providers";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role registers SSO providers' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."sso_providers" x where x."id" = sso_provider.provider;
  if v_row."id" is null then
    return null;
  end if;
  if not (sso_provider.actor is null or coalesce(better_supabase.can_user(sso_provider.actor, 'tenant', v_row."tenant_id", 'sso.manage'), false)) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  return to_jsonb(v_row);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.start_support_session (
  target    uuid,
  reason    text     DEFAULT NULL::text,
  ttl       interval DEFAULT '00:30:00'::interval,
  read_only boolean  DEFAULT true,
  metadata  jsonb    DEFAULT '{}'::jsonb,
  tenant    uuid     DEFAULT NULL::uuid,
  admin_id  uuid     DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  admin uuid;
  session_id uuid;
  started jsonb;
  approval_id uuid;
  approver uuid;
begin
  if service then
    admin := admin_id;
    if admin is null then
      raise exception 'admin_id is required for the service role' using errcode = '22023', hint = 'IMPERSONATION_FORBIDDEN';
    end if;
  else
    admin := auth.uid();
    if admin is null or (admin_id is not null and admin_id <> admin)
      or not "better_supabase"."is_platform"('impersonation.start') then
      raise exception 'Not allowed to start a support session' using errcode = '42501', hint = 'IMPERSONATION_FORBIDDEN';
    end if;
  end if;
  if target = admin then
    raise exception 'An admin cannot start a support session as themselves' using errcode = '22023', hint = 'IMPERSONATION_SELF';
  end if;
  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception 'No user %', target using errcode = 'P0002', hint = 'IMPERSONATION_TARGET_MISSING';
  end if;
  if ttl <= interval '0' or ttl > '4 hours'::interval then
    raise exception 'ttl must be between 0 and %', '4 hours' using errcode = '22023', hint = 'IMPERSONATION_TTL';
  end if;
  -- Viewing the app as platform staff would hand the admin that staff's reach.
  if exists (
    select 1 from auth.users u
    where u.id = target and jsonb_typeof(u.raw_app_meta_data -> 'platform_permissions') = 'array'
      and jsonb_array_length(u.raw_app_meta_data -> 'platform_permissions') > 0
  ) then
    raise exception 'A support session cannot target platform staff' using errcode = '42501', hint = 'IMPERSONATION_TARGET_PLATFORM';
  end if;
  if not coalesce(read_only, true) then
    raise exception 'Support sessions are read-only (blocks.impersonation.options.allowWrites)' using errcode = '42501', hint = 'IMPERSONATION_WRITES_DISABLED';
  end if;
  if coalesce(btrim(reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023', hint = 'IMPERSONATION_REASON_REQUIRED';
  end if;
  -- A second admin approved this start: the approval is consumed below.
  select x."id", x."approved_by" into approval_id, approver
  from "better_supabase"."support_requests" x
  where x."admin_id" = admin
    and x."target_id" = target
    and x."tenant_id" is not distinct from tenant
    and (not x."read_only" or coalesce(read_only, true))
    and x."approved_by" is not null
    and x."approved_by" <> admin
    and x."session_id" is null
    and x."expires_at" > now()
  order by x."approved_at" desc
  limit 1
  for update;
  if approval_id is null then
    raise exception 'A second admin must approve this support session (approve_support_request)' using errcode = '42501', hint = 'IMPERSONATION_APPROVAL_REQUIRED';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_support_start"(uuid, uuid, text, jsonb)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text, $4::jsonb)', v_hook::oid::regproc)
        using admin, target, reason, metadata;
    end if;
  end;
  update "better_supabase"."support_sessions" s set "ended_at" = now(), "ended_by" = 'admin'
  where s."admin_id" = admin and s."ended_at" is null;
  insert into "better_supabase"."support_sessions" ("admin_id", "target_id", "reason", "tenant_id", "read_only", "expires_at", "metadata")
  values (admin, target, coalesce(reason, ''), tenant, read_only, now() + ttl, coalesce(metadata, '{}'))
  returning "id" into session_id;
  update "better_supabase"."support_requests" x set "session_id" = session_id where x."id" = approval_id;
  select jsonb_build_object(
    'id', s."id",
    'admin_id', s."admin_id",
    'target_user_id', s."target_id",
    'reason', s."reason",
    'tenant', s."tenant_id",
    'read_only', s."read_only",
    'started_at', s."started_at",
    'expires_at', s."expires_at",
    'ended_at', s."ended_at",
    'ended_by', s."ended_by",
    'metadata', s."metadata"
  ) into started from "better_supabase"."support_sessions" s where s."id" = session_id;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_support_start"(uuid)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid)', v_hook::oid::regproc)
        using session_id;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'support_session.started',
    category => 'security',
    target_type => 'user',
    record_id => target::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('session_id', session_id, 'reason', reason, 'read_only', read_only, 'request_id', approval_id, 'approved_by', approver),
    idempotency_key => 'support_session.started:' || session_id,
    actor_id => admin,
    support_session => session_id,
    impersonated_by => admin,
    impersonation_reason => reason
  );
  return started;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.stripe_customer_tenants (
  customer text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  return query select t."id" from "better_supabase"."organizations" t where t."stripe_customer_id" = customer;
end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.support_request (
  request_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'id', x."id",
    'admin_id', x."admin_id",
    'target_user_id', x."target_id",
    'reason', x."reason",
    'tenant', x."tenant_id",
    'read_only', x."read_only",
    'metadata', x."metadata",
    'requested_at', x."requested_at",
    'expires_at', x."expires_at",
    'approved_by', x."approved_by",
    'approved_at', x."approved_at",
    'session_id', x."session_id"
  )
  from "better_supabase"."support_requests" x
  where x."id" = $1
    and (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or x."admin_id" = auth.uid() or "better_supabase"."is_platform"('impersonation.start'))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.support_request_approvable (
  request_id uuid
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."support_requests";
begin
  select * into v_row from "better_supabase"."support_requests" x where x."id" = support_request_approvable.request_id;
  return found and v_row."approved_by" is null and v_row."session_id" is null
    and v_row."expires_at" > now()
    and (select auth.uid()) is not null and v_row."admin_id" <> (select auth.uid())
    and coalesce("better_supabase"."is_platform"('impersonation.start'), false);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.support_target_claims (
  target uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  base jsonb;
begin
  select jsonb_build_object(
    'user_id', u.id,
    'authentication_method', 'support',
    'claims', jsonb_strip_nulls(jsonb_build_object(
      'sub', u.id::text,
      'aud', 'authenticated',
      'role', coalesce(nullif(u.role, ''), 'authenticated'),
      'email', u.email,
      'phone', nullif(u.phone, ''),
      'app_metadata', coalesce(u.raw_app_meta_data, '{}'),
      'user_metadata', coalesce(u.raw_user_meta_data, '{}'),
      'is_anonymous', u.is_anonymous,
      'aal', 'aal1',
      'amr', '[]'::jsonb,
      'session_id', gen_random_uuid()
    ))
  ) into base
  from auth.users u where u.id = target;
  if base is null then
    raise exception 'No user %', target using errcode = 'P0002', hint = 'IMPERSONATION_TARGET_MISSING';
  end if;
  return base -> 'claims';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.switch_organization (
  organization uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
begin
  if me is null or not exists (select 1 from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = me) then
    raise exception 'Not a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  if not (exists (select 1 from "better_supabase"."organizations" o where o."id" = organization and o."deleted_at" is null and o."disabled_at" is null) and not better_supabase.tenant_disabled(organization)) then
    raise exception 'The organization is unavailable' using errcode = '42501', hint = 'ORGANIZATION_DISABLED';
  end if;
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}') || jsonb_build_object('tenant_id', organization::text)
  where id = me;
  null;
  return jsonb_build_object('organization_id', organization, 'refresh', true);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.sync_rule_fields (
  subject_type text,
  fields       jsonb
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_count integer;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role syncs rule fields' using errcode = '42501', hint = 'AUTOMATION_FORBIDDEN';
  end if;
  if jsonb_typeof(fields) is distinct from 'array' then
    raise exception 'fields must be an array' using errcode = '22023', hint = 'AUTOMATION_FIELDS_INVALID';
  end if;
  insert into "better_supabase"."automation_fields" ("subject_type", "field_id", "label", "description", "type", "path", "column_type", "nullable", "options", "operators", "position")
  select sync_rule_fields.subject_type, x.value ->> 'id', coalesce(x.value ->> 'label', x.value ->> 'id'), x.value ->> 'description',
    x.value ->> 'type', coalesce(x.value ->> 'column', x.value ->> 'id'), coalesce(x.value ->> 'columnType', 'text'),
    coalesce((x.value ->> 'nullable')::boolean, true), x.value -> 'options', x.value -> 'operators', x.n::integer
  from jsonb_array_elements(fields) with ordinality x(value, n)
  on conflict ("subject_type", "field_id") do update set
    "label" = excluded."label",
    "description" = excluded."description",
    "type" = excluded."type",
    "path" = excluded."path",
    "column_type" = excluded."column_type",
    "nullable" = excluded."nullable",
    "options" = excluded."options",
    "operators" = excluded."operators",
    "position" = excluded."position",
    "updated_at" = now();
  delete from "better_supabase"."automation_fields" x
  where x."subject_type" = sync_rule_fields.subject_type
    and not exists (select 1 from jsonb_array_elements(fields) y where y.value ->> 'id' = x."field_id");
  select count(*) into v_count from "better_supabase"."automation_fields" x where x."subject_type" = sync_rule_fields.subject_type;
  return v_count;
exception when check_violation or not_null_violation then
  raise exception 'A rule field has an invalid id, type, column or column type' using errcode = '22023', hint = 'AUTOMATION_FIELDS_INVALID';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.team_ids_of (
  member uuid
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if team_ids_of.member is distinct from (select auth.uid())
    and coalesce((select auth.jwt() ->> 'role'), 'service_role') <> 'service_role' then
    raise exception 'team_ids_of reads only the caller''s teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  return query select "team_id" from "better_supabase"."team_members" where "user_id" = team_ids_of.member;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.tenant_disabled (
  tenant uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select exists (select 1 from "better_supabase"."organizations" t where t."id" = tenant_disabled.tenant and (t."disabled_at" is not null or t."deleted_at" is not null))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.tenant_entitlement_value (
  tenant uuid,
  key    text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select case when key = any (better_supabase.tenant_entitlements(tenant)) then 'true'::jsonb end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.tenant_entitlements (
  tenant uuid
)
  RETURNS text[]
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  customer_id text := better_supabase.tenant_stripe_customer(tenant);
begin
  if customer_id is null or to_regclass('stripe.active_entitlements') is null then
    return '{}';
  end if;
  return coalesce((
    select array_agg(distinct e.lookup_key order by e.lookup_key)
    from stripe.active_entitlements e
    where e.customer = customer_id
      and e.lookup_key is not null
  ), '{}');
end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.tenant_ids_with_entitlement (
  key text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  ROWS 1
  SET search_path TO ''
  AS $function$
  select t.id::uuid from permdock.member_organization_ids() as t(id)
  where key = any (better_supabase.tenant_entitlements(t.id::uuid))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.tenant_stripe_customer (
  tenant uuid
)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  return (select t."stripe_customer_id" from "better_supabase"."organizations" t where t."id" = tenant);
end
$function$;

CREATE OR REPLACE FUNCTION better_supabase.transfer_ownership (
  organization uuid,
  new_owner    uuid,
  former_role  text DEFAULT 'admin'::text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), organization, 'organization.transfer_ownership'), false)) then
    raise exception 'Not allowed to transfer ownership' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  -- Only an owner hands ownership on, so the permission alone can't make its
  -- holder an owner.
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not exists (
    select 1 from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = me and m."role" = 'owner'
  ) then
    raise exception 'Only an owner can transfer ownership' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if not (exists (select 1 from "better_supabase"."organizations" o where o."id" = organization and o."deleted_at" is null and o."disabled_at" is null) and not better_supabase.tenant_disabled(organization)) then
    raise exception 'The organization is unavailable' using errcode = '42501', hint = 'ORGANIZATION_DISABLED';
  end if;
  if not exists (select 1 from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = new_owner) then
    raise exception 'The new owner must be a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  if better_supabase.user_disabled(new_owner) then
    raise exception 'The new owner is disabled' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  -- One statement for both rows, so a statement-level guard on the number of
  -- owners sees the transfer as a whole.
  update "public"."organization_memberships" m set "role" = case
      when m."user_id" = new_owner then 'owner'
      else former_role
    end
  where m."organization_id" = organization
    and (m."user_id" = new_owner
      or (me is not null and me <> new_owner and m."user_id" = me and m."role" = 'owner'));
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_member_change"(uuid, uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text)', v_hook::oid::regproc)
        using organization, new_owner, 'owner';
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.ownership_transferred',
    category => 'membership',
    target_type => 'user',
    record_id => new_owner::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', new_owner, 'role', 'owner')
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.unlink (
  tenant      uuid,
  kind        text,
  source_type text,
  source_id   text,
  target_type text,
  target_id   text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_column
declare
  v_kind text;
  v_inverted boolean;
  v_acyclic boolean;
  v_single boolean;
  v_symmetric boolean;
  v_source_type text;
  v_source_id text;
  v_target_type text;
  v_target_id text;
  v_old "better_supabase"."relations";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (auth.role() = 'service_role' or coalesce(better_supabase.can('tenant', unlink.tenant, 'relations.manage'), false)) then
    raise exception 'not allowed to unlink records' using errcode = '42501', hint = 'RELATION_FORBIDDEN';
  end if;

  select k.canonical, k.inverted, k.acyclic, k.single, k.both_ways
    into v_kind, v_inverted, v_acyclic, v_single, v_symmetric
    from (values ('blocks', 'blocks', false, true, false, false, 'blocked_by'), ('blocked_by', 'blocks', true, true, false, false, 'blocks'), ('parent', 'parent', false, true, true, false, 'children'), ('children', 'parent', true, true, true, false, 'parent'), ('relates', 'relates', false, false, false, true, 'relates'), ('created_from', 'created_from', false, true, true, false, 'converted_to'), ('converted_to', 'created_from', true, true, true, false, 'created_from')) as k(name, canonical, inverted, acyclic, single, both_ways, opposite) where k.name = unlink.kind;
  if v_kind is null then
    raise exception 'unknown relation kind' using errcode = '22023', hint = 'RELATION_KIND_UNKNOWN';
  end if;
  if v_inverted then
    v_source_type := unlink.target_type; v_source_id := unlink.target_id;
    v_target_type := unlink.source_type; v_target_id := unlink.source_id;
  else
    v_source_type := unlink.source_type; v_source_id := unlink.source_id;
    v_target_type := unlink.target_type; v_target_id := unlink.target_id;
  end if;
  if v_symmetric and (v_source_type, v_source_id) > (v_target_type, v_target_id) then
    select v_target_type, v_target_id, v_source_type, v_source_id
      into v_source_type, v_source_id, v_target_type, v_target_id;
  end if;
  if not (true)
     or not (true) then
    raise exception 'not allowed to unlink these records' using errcode = '42501', hint = 'RELATION_SUBJECT_FORBIDDEN';
  end if;
  delete from "better_supabase"."relations"
    where "tenant_id" = unlink.tenant and "kind" = v_kind
      and "source_type" = v_source_type and "source_id" = v_source_id
      and "target_type" = v_target_type and "target_id" = v_target_id
    returning * into v_old;
  if v_old."id" is null then
    return jsonb_build_object('removed', false, 'data', null);
  end if;
  null;
  return jsonb_build_object('removed', true, 'data', v_old."data");
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.unregister_sso_provider (
  provider uuid,
  actor    uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."sso_providers";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role registers SSO providers' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."sso_providers" x where x."id" = unregister_sso_provider.provider;
  if v_row."id" is null then
    return null;
  end if;
  if not (unregister_sso_provider.actor is null or coalesce(better_supabase.can_user(unregister_sso_provider.actor, 'tenant', v_row."tenant_id", 'sso.manage'), false)) then
    raise exception 'You may not manage this organization''s SSO' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  delete from "better_supabase"."sso_providers" x where x."id" = v_row."id";
  perform better_supabase.audit_event(
    event_type => 'sso_provider.unregistered',
    category => 'security',
    target_type => 'sso_provider',
    record_id => v_row."id"::text,
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'providerId', v_row."id", 'domains', to_jsonb(v_row."domains"), 'userId', unregister_sso_provider.actor),
    actor_id => unregister_sso_provider.actor
  );
  return to_jsonb(v_row);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.unreported_usage (
  max_rows     integer DEFAULT 500,
  skip_meters  text[]  DEFAULT '{}'::text[],
  skip_tenants uuid[]  DEFAULT '{}'::uuid[]
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  with c as materialized (
    select * from "better_supabase"."usage_counters" c
    where c."value" > c."reported_value"
      and c."meter" <> all (coalesce(unreported_usage.skip_meters, '{}'))
      and c."tenant_id" <> all (coalesce(unreported_usage.skip_tenants, '{}'))
    order by c."day"
    limit max_rows
  ),
  tenants as materialized (
    select t.tenant, better_supabase.tenant_entitlements(t.tenant)::text[] as entitled
    from (select distinct c."tenant_id" as tenant from c) t
  ),
  quota as materialized (
    select distinct on (p.tenant, p.meter) p.tenant, p.meter, q."limit" as quota_limit, q."period" as period
    from (select distinct c."tenant_id" as tenant, c."meter" as meter from c) p
    join tenants t on t.tenant = p.tenant
    join "better_supabase"."usage_quotas" q on q."meter" = p.meter
      and (q."tenant_id" = p.tenant or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any (t.entitled))))
    order by p.tenant, p.meter, (q."tenant_id" is not null) desc, q."limit" desc nulls first
  ),
  win as materialized (
    select d.tenant, d.period, d.day, "better_supabase"."usage_window_start"(d.tenant, d.period, d.day) as since
    from (
      select distinct c."tenant_id" as tenant, q.period, c."day" as day
      from c
      left join quota q on q.tenant = c."tenant_id" and q.meter = c."meter"
    ) d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id', c."tenant_id",
    'meter', c."meter",
    'day', c."day",
    'value', c."value",
    'reported_value', c."reported_value",
    'included', q.quota_limit,
    'unlimited', q.period is not null and q.quota_limit is null,
    'window_before', (
      select coalesce(sum(o."value"), 0)
      from "better_supabase"."usage_counters" o
      where o."tenant_id" = c."tenant_id" and o."meter" = c."meter"
        and o."day" < c."day"
        and o."day" >= w.since
    )
  ) order by c."day", c."meter"), '[]'::jsonb)
  from c
  left join quota q on q.tenant = c."tenant_id" and q.meter = c."meter"
  join win w on w.tenant = c."tenant_id" and w.period is not distinct from q.period and w.day = c."day"
$function$;

CREATE OR REPLACE FUNCTION better_supabase.update_invitation (
  invitation_id uuid,
  invitee_email text  DEFAULT NULL::text,
  invitee_role  text  DEFAULT NULL::text,
  prefill       jsonb DEFAULT NULL::jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  service boolean := coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin');
  current_invite "better_supabase"."invitations";
  updated "better_supabase"."invitations";
  tenant uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if invitee_email is not null and btrim(invitee_email) = '' then
    raise exception 'The email address is empty' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  select * into current_invite from "better_supabase"."invitations" i
  where i."id" = invitation_id and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null
  for update;
  if current_invite."id" is null then
    raise exception 'No open invitation %', invitation_id using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if current_invite."expires_at" < now() then
    raise exception 'The invitation has expired; resend it to renew it' using errcode = 'P0002', hint = 'INVITATION_EXPIRED';
  end if;
  tenant := current_invite."tenant_id";
  if not service and not coalesce(better_supabase.member_can(auth.uid(), tenant, 'members.invite'), false) then
    raise exception 'Not allowed to invite members' using errcode = '42501', hint = 'INVITATION_FORBIDDEN';
  end if;
  if better_supabase.tenant_disabled(tenant) or not exists (select 1 from "better_supabase"."organizations" o where o."id" = tenant) then
    raise exception 'The organization is not active' using errcode = 'P0002', hint = 'INVITATION_INVALID';
  end if;
  if invitee_role is not null and false then
    raise exception 'Unknown role %', invitee_role using errcode = '23514', hint = 'INVITATION_ROLE_UNKNOWN';
  end if;
  if not service and (
    not better_supabase.can_assign(tenant, current_invite."role"::text)
    or (invitee_role is not null and not better_supabase.can_assign(tenant, (invitee_role)::text))
  ) then
    raise exception 'That role is above your own' using errcode = '42501', hint = 'INVITATION_ROLE_FORBIDDEN';
  end if;
  if invitee_email is not null and exists (
    select 1 from "public"."organization_memberships" m join auth.users u on u.id = m."user_id"
    where m."organization_id" = tenant and lower(u.email) = lower(btrim(invitee_email))
  ) then
    raise exception '% is already a member', invitee_email using errcode = '23505', hint = 'INVITATION_ALREADY_MEMBER';
  end if;
  if invitee_email is not null then
    delete from "better_supabase"."invitations" i
    where i."tenant_id" = tenant
      and lower(i."email") = lower(btrim(invitee_email))
      and i."id" <> invitation_id
      and i."accepted_at" is null and i."declined_at" is null and i."revoked_at" is null;
  end if;

  updated := current_invite;
    if invitee_email is not null then
      updated."email" := lower(btrim(invitee_email));
    end if;
    if invitee_role is not null then
      updated."role" := invitee_role;
    end if;
    update "better_supabase"."invitations" i
    set "email" = updated."email",
      "role" = updated."role"
    where i."id" = invitation_id
    returning * into updated;
  perform better_supabase.audit_event(
    event_type => 'invitation.updated',
    category => 'membership',
    target_type => 'invitation',
    record_id => updated."id"::text,
    tenant => (tenant)::uuid,
    metadata => jsonb_build_object('invitationId', updated."id", 'organizationId', tenant::text, 'email', updated."email", 'role', updated."role")
  );
  return (jsonb_build_object(
    'id', updated."id",
    'tenant', updated."tenant_id",
    'email', updated."email",
    'role', updated."role",
    'expires_at', updated."expires_at",
    'created_at', updated."created_at",
    'invited_by', updated."invited_by",
    'organization', (select jsonb_build_object('id', o."id", 'name', o."name")
      from "better_supabase"."organizations" o where o."id" = updated."tenant_id"),
    'prefill', '{}'::jsonb,
    'token', null
  ) || "better_supabase"."invitation_extra"(updated."id")) - 'token';
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.update_member_role (
  organization uuid,
  member       uuid,
  role         text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  previous text;
  previous_assignable text;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.member_can(auth.uid(), organization, 'members.update_role'), false)) then
    raise exception 'Not allowed to change roles' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if not (exists (select 1 from "better_supabase"."organizations" o where o."id" = organization and o."deleted_at" is null and o."disabled_at" is null) and not better_supabase.tenant_disabled(organization)) then
    raise exception 'The organization is unavailable' using errcode = '42501', hint = 'ORGANIZATION_DISABLED';
  end if;
  select m."role", m."role"::text into previous, previous_assignable
  from "public"."organization_memberships" m where m."organization_id" = organization and m."user_id" = member;
  if not found then
    raise exception 'Not a member' using errcode = 'P0002', hint = 'ORGANIZATION_NOT_MEMBER';
  end if;
  -- Checked here whatever blocks.organizations.options.assignmentGuard
  -- says: a guard that checks only client writes never sees this function's.
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and coalesce(member = auth.uid(), false) then
    raise exception 'You cannot change your own role' using errcode = '42501', hint = 'ORGANIZATION_SELF_ROLE';
  end if;
  if not better_supabase.can_assign(organization, previous_assignable)
    or not better_supabase.can_assign(organization, (role)::text) then
    raise exception 'That role is above your own' using errcode = '42501', hint = 'ORGANIZATION_ROLE_CEILING';
  end if;
  update "public"."organization_memberships" set "role" = role
  where "organization_id" = organization and "user_id" = member;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_member_change"(uuid, uuid, text)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::uuid, $3::text)', v_hook::oid::regproc)
        using organization, member, 'role';
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.role_changed',
    category => 'membership',
    target_type => 'user',
    record_id => member::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', member, 'role', role, 'previousRole', previous)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.update_member_roles (
  organization uuid,
  members      uuid[],
  role         text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
declare
  one uuid;
  succeeded jsonb := '[]'::jsonb;
  failed jsonb := '[]'::jsonb;
  failure_hint text;
  failure_message text;
begin
  if coalesce(cardinality(members), 0) > 500 then
    raise exception 'A bulk call takes at most 500 members' using errcode = '22023', hint = 'BULK_TOO_MANY';
  end if;
  for one in select distinct m from unnest(members) m loop
    begin
      perform "better_supabase"."update_member_role"(organization, one, role);
      succeeded := succeeded || to_jsonb(one::text);
    exception when others then
      get stacked diagnostics failure_hint = pg_exception_hint, failure_message = message_text;
      failed := failed || jsonb_build_object('id', one::text, 'code', failure_hint, 'message', failure_message);
    end;
  end loop;
  return jsonb_build_object('succeeded', succeeded, 'failed', failed);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.update_organization (
  organization uuid,
  attrs        jsonb
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
#variable_conflict use_variable
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) and not coalesce(better_supabase.member_can(auth.uid(), organization, 'organization.update'), false) then
    raise exception 'Not allowed to update the organization' using errcode = '42501', hint = 'ORGANIZATION_FORBIDDEN';
  end if;
  if attrs ? 'slug' then
    case "better_supabase"."organization_slug_problem"(coalesce(attrs ->> 'slug', ''), organization)
      when 'invalid' then raise exception 'Invalid slug "%"', attrs ->> 'slug' using errcode = '23514', hint = 'ORGANIZATION_SLUG_INVALID';
      when 'reserved' then raise exception 'The slug "%" is reserved', attrs ->> 'slug' using errcode = '23514', hint = 'ORGANIZATION_SLUG_RESERVED';
      when 'taken' then raise exception 'The slug "%" is taken', attrs ->> 'slug' using errcode = '23505', hint = 'ORGANIZATION_SLUG_TAKEN';
      else null;
    end case;
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."before_organization_update"(uuid, jsonb)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::jsonb)', v_hook::oid::regproc)
        using organization, attrs;
    end if;
  end;
  update "better_supabase"."organizations" o
  set "name" = case when attrs ? 'name' then r."name" else o."name" end,
    "slug" = case when attrs ? 'slug' then r."slug" else o."slug" end
  from jsonb_populate_record(null::"better_supabase"."organizations", attrs) r
  where o."id" = organization;
  if not found then
    raise exception 'No organization %', organization using errcode = 'P0002', hint = 'ORGANIZATION_NOT_FOUND';
  end if;
  declare
    v_hook regprocedure := to_regprocedure('"public"."after_organization_update"(uuid, jsonb)');
  begin
    if v_hook is not null then
      execute format('select %s($1::uuid, $2::jsonb)', v_hook::oid::regproc)
        using organization, attrs;
    end if;
  end;
  perform better_supabase.audit_event(
    event_type => 'organization.updated',
    category => 'configuration',
    target_type => 'organization',
    record_id => organization::text,
    tenant => (organization)::uuid,
    metadata => jsonb_build_object('organizationId', organization::text, 'userId', auth.uid())
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.update_organization_domain (
  id             uuid,
  auto_join_role text    DEFAULT NULL::text,
  enforce_sso    boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."sso_domains";
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select * into v_row from "better_supabase"."sso_domains" x where x."id" = update_organization_domain.id for update;
  if v_row."id" is null or not coalesce(better_supabase.can('tenant', v_row."tenant_id", 'sso.manage'), false) then
    raise exception 'No domain you manage has this id' using errcode = 'P0002', hint = 'SSO_DOMAIN_NOT_FOUND';
  end if;
  if update_organization_domain.auto_join_role is not null and not (update_organization_domain.auto_join_role = any (array['admin', 'member']::text[])) then
    raise exception 'Auto-join cannot assign role %', update_organization_domain.auto_join_role using errcode = '22023', hint = 'SSO_ROLE_INVALID';
  end if;
  if update_organization_domain.auto_join_role is not null
    and not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin'))
    and not coalesce(better_supabase.can_assign(v_row."tenant_id", update_organization_domain.auto_join_role), false) then
    raise exception 'You may not assign role %', update_organization_domain.auto_join_role using errcode = '42501', hint = 'SSO_ROLE_FORBIDDEN';
  end if;
  if (update_organization_domain.enforce_sso or update_organization_domain.auto_join_role is not null) and v_row."verified_at" is null then
    raise exception 'Verify the domain first' using errcode = '22023', hint = 'SSO_DOMAIN_NOT_VERIFIED';
  end if;
  update "better_supabase"."sso_domains" x set "auto_join_role" = update_organization_domain.auto_join_role, "enforce_sso" = update_organization_domain.enforce_sso
  where x."id" = v_row."id"
  returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'sso_domain.updated',
    category => 'security',
    target_type => 'domain',
    record_id => v_row."id"::text,
    target_label => v_row."domain",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'domainId', v_row."id", 'domain', v_row."domain", 'userId', auth.uid()),
    actor_id => auth.uid()
  );
  return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.update_ssf_stream (
  id    uuid,
  patch jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."ssf_streams";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'only the service role manages shared signals streams' using errcode = '42501', hint = 'SECURITY_EVENT_FORBIDDEN';
  end if;
  update "better_supabase"."ssf_streams" s set
    "description" = case when update_ssf_stream.patch ? 'description' then update_ssf_stream.patch ->> 'description' else s."description" end,
    "events_requested" = case when update_ssf_stream.patch ? 'eventsRequested'
      then array(select jsonb_array_elements_text(update_ssf_stream.patch -> 'eventsRequested')) else s."events_requested" end,
    "events_delivered" = case when update_ssf_stream.patch ? 'eventsDelivered'
      then array(select jsonb_array_elements_text(update_ssf_stream.patch -> 'eventsDelivered')) else s."events_delivered" end
  where s."id" = update_ssf_stream.id
  returning s.* into v_row;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_row."id",
    'tenant', v_row."tenant",
    'receiver', v_row."receiver",
    'audience', to_jsonb(v_row."audience"),
    'description', v_row."description",
    'eventsRequested', to_jsonb(v_row."events_requested"),
    'eventsDelivered', to_jsonb(v_row."events_delivered"),
    'method', v_row."delivery_method",
    'endpointUrl', null::text,
    'status', v_row."status",
    'reason', v_row."reason",
    'createdAt', v_row."created_at",
    'updatedAt', v_row."updated_at"
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.update_team (
  team        uuid,
  name        text,
  description text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  select "tenant_id" into v_tenant from "better_supabase"."teams" where "id" = update_team.team;
  if not found then
    raise exception 'team not found' using errcode = 'P0002', hint = 'TEAM_NOT_FOUND';
  end if;
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', v_tenant, 'teams.manage'), false)) then
    raise exception 'not allowed to manage teams' using errcode = '42501', hint = 'TEAM_FORBIDDEN';
  end if;
  update "better_supabase"."teams" as t
  set "name" = coalesce(update_team.name, t."name"),
      "description" = coalesce(update_team.description, t."description"),
      "updated_at" = now()
  where t."id" = update_team.team;
  perform better_supabase.audit_event(
    event_type => 'team.updated',
    category => 'membership',
    target_type => 'team',
    record_id => (update_team.team)::text,
    tenant => (v_tenant)::uuid,
    metadata => jsonb_build_object('organizationId', v_tenant, 'id', update_team.team, 'name', update_team.name)
  );
  return (select jsonb_build_object('id', x."id", 'name', x."name", 'slug', x."slug", 'description', x."description", 'status', x."status") from "better_supabase"."teams" x where x."id" = update_team.team);
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_breakdown (
  tenant uuid,
  meter  text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  quota record;
  win record;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  select * into quota from "better_supabase"."usage_quota"(tenant, meter);
  select * into win from "better_supabase"."usage_window"(tenant, coalesce(quota.period, 'month'));
  return '[]'::jsonb;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_history (
  tenant    uuid,
  meter     text    DEFAULT NULL::text,
  max_rows  integer DEFAULT 100,
  before_id bigint  DEFAULT NULL::bigint
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  return '[]'::jsonb;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_meters()
  RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select '{}'::jsonb
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_overview (
  tenant uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  return (
    with scoped as materialized (
      select q.* from "better_supabase"."usage_quotas" q
      where q."tenant_id" = usage_overview.tenant
        or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any ((select better_supabase.tenant_entitlements(usage_overview.tenant))::text[])))
    ),
    meters as (
      select jsonb_object_keys("better_supabase"."usage_meters"()) as meter
      union
      select q."meter" from scoped q
      union
      select distinct c."meter" from "better_supabase"."usage_counters" c
      where c."tenant_id" = usage_overview.tenant
    ),
    quota as (
      select distinct on (q."meter")
        q."meter" as meter,
        q."limit" as quota_limit,
        q."period" as period
      from scoped q
      join meters m on m.meter = q."meter"
      order by q."meter", (q."tenant_id" is not null) desc, q."limit" desc nulls first
    ),
    chosen as (
      select m.meter,
        quota.quota_limit,
        quota.period as quota_period,
        coalesce(quota.period, 'month') as period
      from meters m
      left join quota on quota.meter = m.meter
    ),
    win as (
      select p.period, w.starts_at, w.ends_at
      from (select distinct chosen.period from chosen) p
      cross join lateral "better_supabase"."usage_window"(usage_overview.tenant, p.period) w
    ),
    used as (
      select ch.meter, coalesce(sum(c."value"), 0)::numeric as used
      from chosen ch
      join win w on w.period = ch.period
      left join "better_supabase"."usage_counters" c
        on c."tenant_id" = usage_overview.tenant
        and c."meter" = ch.meter
        and c."day" >= (w.starts_at at time zone 'utc')::date
        and c."day" < greatest((w.ends_at at time zone 'utc')::date, (w.starts_at at time zone 'utc')::date + 1)
      group by ch.meter
    ),
    catalog as (
      select "better_supabase"."usage_meters"() as meters
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'meter', ch.meter,
        'used', u.used,
        'limit', ch.quota_limit,
        'remaining', case
          when ch.quota_limit is null then null
          else greatest(ch.quota_limit - u.used, 0)
        end,
        'unlimited', ch.quota_period is not null and ch.quota_limit is null,
        'period', ch.period,
        'resets_at', w.ends_at,
        'starts_at', w.starts_at
      ) || coalesce(catalog.meters -> ch.meter, '{}'::jsonb)
      order by ch.meter
    ), '[]'::jsonb)
    from chosen ch
    join used u on u.meter = ch.meter
    join win w on w.period = ch.period
    cross join catalog
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_quota (
  tenant uuid,
  meter  text
)
  RETURNS TABLE (
    quota_limit numeric,
    period      text
  )
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select q.quota_limit, q.period
  from "better_supabase"."usage_quotas_for"(array[usage_quota.tenant], array[usage_quota.meter]) q
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_quotas_for (
  tenants uuid[],
  meters  text[]
)
  RETURNS TABLE (
    tenant      uuid,
    meter       text,
    quota_limit numeric,
    period      text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  with t as materialized (
    select d.tenant, case when exists (select 1 from "better_supabase"."usage_quotas" pq where pq."meter" = any (usage_quotas_for.meters) and pq."tenant_id" is null and pq."plan" <> '*') then better_supabase.tenant_entitlements(d.tenant)::text[] end as entitled
    from (select distinct u.tenant from unnest(usage_quotas_for.tenants) u(tenant) where u.tenant is not null) d
  )
  select distinct on (t.tenant, q."meter") t.tenant, q."meter", q."limit", q."period"
  from t
  join "better_supabase"."usage_quotas" q on q."meter" = any (usage_quotas_for.meters)
    and (q."tenant_id" = t.tenant or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any (t.entitled))))
  order by t.tenant, q."meter", (q."tenant_id" is not null) desc, q."limit" desc nulls first
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_remaining (
  tenant uuid,
  meter  text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  return (
    with quota as (
      select q."limit" as quota_limit, q."period" as period
      from "better_supabase"."usage_quotas" q
      where q."meter" = usage_remaining.meter
        and (q."tenant_id" = usage_remaining.tenant or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any (better_supabase.tenant_entitlements(tenant)))))
      order by (q."tenant_id" is not null) desc, q."limit" desc nulls first
      limit 1
    ),
    win as (
      select w.starts_at, w.ends_at
      from "better_supabase"."usage_window"(usage_remaining.tenant, coalesce((select quota.period from quota), 'month')) w
    ),
    used as (
      select coalesce(sum(c."value"), 0)::numeric as used
      from "better_supabase"."usage_counters" c
      cross join win w
      where c."tenant_id" = usage_remaining.tenant
        and c."meter" = usage_remaining.meter
        and c."day" >= (w.starts_at at time zone 'utc')::date
        and c."day" < greatest((w.ends_at at time zone 'utc')::date, (w.starts_at at time zone 'utc')::date + 1)
    )
    select jsonb_build_object(
      'used', (select used.used from used),
      'limit', (select quota.quota_limit from quota),
      'remaining', case
        when (select quota.quota_limit from quota) is null then null
        else greatest((select quota.quota_limit from quota) - (select used.used from used), 0)
      end,
      'resets_at', (select win.ends_at from win)
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_status (
  tenant uuid,
  meter  text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or coalesce(better_supabase.can('tenant', tenant, 'usage.read'), false)) then
    raise exception 'Not allowed to read usage in this tenant' using errcode = '42501', hint = 'USAGE_FORBIDDEN';
  end if;
  return (
    with quota as (
      select q."limit" as quota_limit, q."period" as period
      from "better_supabase"."usage_quotas" q
      where q."meter" = usage_status.meter
        and (q."tenant_id" = usage_status.tenant or (q."tenant_id" is null and (q."plan" = '*' or q."plan" = any (better_supabase.tenant_entitlements(tenant)))))
      order by (q."tenant_id" is not null) desc, q."limit" desc nulls first
      limit 1
    ),
    win as (
      select w.starts_at, w.ends_at
      from "better_supabase"."usage_window"(usage_status.tenant, coalesce((select quota.period from quota), 'month')) w
    ),
    used as (
      select coalesce(sum(c."value"), 0)::numeric as used
      from "better_supabase"."usage_counters" c
      cross join win w
      where c."tenant_id" = usage_status.tenant
        and c."meter" = usage_status.meter
        and c."day" >= (w.starts_at at time zone 'utc')::date
        and c."day" < greatest((w.ends_at at time zone 'utc')::date, (w.starts_at at time zone 'utc')::date + 1)
    )
    select jsonb_build_object(
      'meter', usage_status.meter,
      'used', (select used.used from used),
      'limit', (select quota.quota_limit from quota),
      'remaining', case
        when (select quota.quota_limit from quota) is null then null
        else greatest((select quota.quota_limit from quota) - (select used.used from used), 0)
      end,
      'unlimited', (select quota.period from quota) is not null and (select quota.quota_limit from quota) is null,
      'period', coalesce((select quota.period from quota), 'month'),
      'resets_at', (select win.ends_at from win),
      'starts_at', (select win.starts_at from win)
    ) || coalesce("better_supabase"."usage_meters"() -> usage_status.meter, '{}'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_used (
  tenant uuid,
  meter  text,
  period text DEFAULT 'month'::text
)
  RETURNS numeric
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(sum(c."value"), 0)::numeric
  from "better_supabase"."usage_counters" c, "better_supabase"."usage_window"(usage_used.tenant, usage_used.period) w
  where c."tenant_id" = usage_used.tenant
    and c."meter" = usage_used.meter
    and c."day" >= (w.starts_at at time zone 'utc')::date
    and c."day" < greatest((w.ends_at at time zone 'utc')::date, (w.starts_at at time zone 'utc')::date + 1)
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_window (
  tenant uuid,
  period text DEFAULT 'month'::text
)
  RETURNS TABLE (
    starts_at timestamp with time zone,
    ends_at   timestamp with time zone
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_period text := coalesce(usage_window.period, 'month');
  v_start timestamptz;
  v_end timestamptz;
begin
  if v_period = 'billing' then
    if to_regprocedure('"public"."usage_billing_period"(uuid)') is not null then
      -- Not a literal name, so plpgsql_check passes without the hook.
      execute format('select h.starts_at, h.ends_at from %s($1) h', to_regprocedure('"public"."usage_billing_period"(uuid)')::oid::regproc)
        into v_start, v_end using usage_window.tenant;
    end if;
    if v_start is null or v_end is null or v_end <= v_start then
      v_period := 'month';
      v_start := null;
    end if;
  end if;
  if v_start is null then
    v_start := date_trunc(v_period, now() at time zone 'utc') at time zone 'utc';
    v_end := v_start + ('1 ' || v_period)::interval;
  end if;
  return query select v_start, v_end;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.usage_window_start (
  tenant uuid,
  period text,
  day    date
)
  RETURNS date
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_length interval;
  v_steps integer := 0;
begin
  if usage_window_start.period is null then
    return usage_window_start.day;
  end if;
  if usage_window_start.period <> 'billing' then
    return date_trunc(usage_window_start.period, usage_window_start.day)::date;
  end if;
  select w.starts_at, w.ends_at into v_start, v_end
  from "better_supabase"."usage_window"(usage_window_start.tenant, 'billing') w;
  v_length := age(v_end, v_start);
  while usage_window_start.day < (v_start at time zone 'utc')::date and v_steps < 120 loop
    v_start := v_start - v_length;
    v_steps := v_steps + 1;
  end loop;
  if usage_window_start.day < (v_start at time zone 'utc')::date then
    return date_trunc('month', usage_window_start.day)::date;
  end if;
  return (v_start at time zone 'utc')::date;
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.verify_api_key (
  public_id   text,
  secret_hash text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  found "better_supabase"."api_keys";
  started timestamptz;
  hits integer;
begin
  select * into found from "better_supabase"."api_keys" k where k."public_id" = verify_api_key.public_id;
  if found."id" is null
    or found."secret_hash" <> verify_api_key.secret_hash
    or (found."expires_at" is not null and found."expires_at" <= now())
    or (found."revoked_at" is not null and found."revoked_at" <= now())
    or (found."user_id" is not null and better_supabase.user_disabled(found."user_id"))
    or (found."user_id" is not null and exists (
      select 1 from auth.users u
      where u.id = found."user_id" and (u.banned_until > now() or u.deleted_at is not null)
    ))
    or (found."tenant_id" is not null and better_supabase.tenant_disabled(found."tenant_id"))
    or (found."user_id" is not null and found."tenant_id" is not null
      and better_supabase.organization_member_role(found."tenant_id", found."user_id") is null)
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if found."rate_limit" is not null then
    -- One update counts the hit and, for an allowed request, touches last_used_at.
    update "better_supabase"."api_keys" k set
      "window_started_at" = case when (k."window_started_at" is null or k."window_started_at" + interval '1 minute' <= now()) then now() else k."window_started_at" end,
      "window_hits" = case when (k."window_started_at" is null or k."window_started_at" + interval '1 minute' <= now()) then 1 else k."window_hits" + 1 end,
      "last_used_at" = case when case when (k."window_started_at" is null or k."window_started_at" + interval '1 minute' <= now()) then 1 else k."window_hits" + 1 end <= k."rate_limit" and (k."last_used_at" is null or k."last_used_at" + interval '60 seconds' <= now()) then now() else k."last_used_at" end
    where k."id" = found."id"
    returning k."window_started_at", k."window_hits" into started, hits;
    if hits > found."rate_limit" then
      return jsonb_build_object(
        'status', 'rate_limited',
        'retry_after', greatest(1, ceil(extract(epoch from started + interval '1 minute' - now()))::integer)
      );
    end if;
  elsif (found."last_used_at" is null or found."last_used_at" + interval '60 seconds' <= now()) then
    update "better_supabase"."api_keys" k set "last_used_at" = now() where k."id" = found."id";
  end if;
  return jsonb_build_object('status', 'ok', 'key', jsonb_build_object(
    'id', found."id",
    'organization_id', found."tenant_id",
    'user_id', found."user_id",
    'name', found."name",
    'prefix', found."prefix",
    'public_id', found."public_id",
    'scopes', to_jsonb(found."scopes"),
    'kind', found."kind",
    'rate_limit', found."rate_limit",
    'expires_at', found."expires_at",
    'last_used_at', found."last_used_at",
    'revoked_at', found."revoked_at",
    'rotated_from', found."rotated_from",
    'created_by', found."created_by",
    'created_at', found."created_at",
    'state', case
      when found."revoked_at" is not null and found."revoked_at" <= now() then 'revoked'
      when found."expires_at" is not null and found."expires_at" <= now() then 'expired'
      when found."revoked_at" is not null then 'grace'
      else 'active'
    end
  ));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.verify_organization_domain (
  id    uuid,
  actor uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  v_row "better_supabase"."sso_domains";
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Only the service role verifies domains' using errcode = '42501', hint = 'SSO_FORBIDDEN';
  end if;
  select * into v_row from "better_supabase"."sso_domains" x where x."id" = verify_organization_domain.id for update;
  if v_row."id" is null or not (verify_organization_domain.actor is null or coalesce(better_supabase.can_user(verify_organization_domain.actor, 'tenant', v_row."tenant_id", 'sso.manage'), false)) then
    raise exception 'No domain you manage has this id' using errcode = 'P0002', hint = 'SSO_DOMAIN_NOT_FOUND';
  end if;
  if v_row."verified_at" is not null then
    return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
  end if;
  if exists (select 1 from "better_supabase"."sso_domains" x where x."domain" = v_row."domain" and x."verified_at" is not null) then
    raise exception 'Another organization has verified %', v_row."domain" using errcode = '23505', hint = 'SSO_DOMAIN_TAKEN';
  end if;
  update "better_supabase"."sso_domains" x set "verified_at" = now() where x."id" = v_row."id" returning * into v_row;
  perform better_supabase.audit_event(
    event_type => 'sso_domain.verified',
    category => 'security',
    target_type => 'domain',
    record_id => v_row."id"::text,
    target_label => v_row."domain",
    tenant => (v_row."tenant_id")::uuid,
    metadata => jsonb_build_object('organizationId', v_row."tenant_id"::text, 'domainId', v_row."id", 'domain', v_row."domain", 'userId', verify_organization_domain.actor),
    actor_id => verify_organization_domain.actor
  );
  return to_jsonb(v_row) - 'verification_token' || jsonb_build_object('record', jsonb_build_object('type', 'TXT', 'name', '_better-supabase.' || v_row."domain", 'value', 'better-supabase-domain-verification=' || v_row."verification_token"));
end;
$function$;

CREATE OR REPLACE FUNCTION better_supabase.within_quota (
  tenant   uuid,
  meter    text,
  quantity bigint DEFAULT 1
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  quota record;
begin
  if not (coalesce(nullif((select auth.jwt()) ->> 'role', ''), session_user::text) in ('service_role', 'postgres', 'supabase_admin') or tenant::text in (select t.id::text from permdock.member_organization_ids() as t(id))) then
    return false;
  end if;
  select * into quota from "better_supabase"."usage_quota"(tenant, meter);
  if quota.quota_limit is null then
    return true;
  end if;
  return "better_supabase"."usage_used"(tenant, meter, quota.period) + quantity <= quota.quota_limit;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_customer_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_organization_ids()
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select distinct (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and jsonb_typeof(ms.roles) = 'array'
    and jsonb_array_length(ms.roles) > 0
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select distinct (k ->> 'tenant')::uuid
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '[]'::jsonb end
  ) r(role)
  where jsonb_typeof(k) = 'object'
    and coalesce((select "permdock".permdock_user_id())::text, '') = ''
    and coalesce(k ->> 'tenant', '') <> '';
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.member_team_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select null::uuid where false -- no team memberships table configured
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_api_key_allows (
  p_grant text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  return (
  select case
    when k is null or k = 'null'::jsonb then true
    when exists (
      select 1 from "permdock".role_permissions rp
      where rp.grant_key = p_grant and rp.effect = 'deny'
    ) then true
    when jsonb_typeof(k) is distinct from 'object' or jsonb_typeof(k -> 'scopes') is distinct from 'array' then false
    else exists (
      select 1
      from jsonb_array_elements_text(k -> 'scopes') s(permission)
      where s.permission = split_part(split_part(p_grant, '#', 1), '@', 1)
    )
  end
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  );
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_cancel (
  p_filter jsonb,
  p_by     text,
  p_note   text,
  p_now    text
)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  with cancelled as (
    update "better_supabase"."approval_requests" a
    set "body" = (a."body" - 'note') || jsonb_strip_nulls(jsonb_build_object(
        'status', 'rejected', 'resolvedAt', p_now, 'resolvedBy', 'system:' || p_by, 'note', p_note
      ))
    where a."body" ->> 'status' = 'pending'
      and (p_filter ->> 'status' is null or a."body" ->> 'status' = p_filter ->> 'status')
      and (p_filter ->> 'tenant' is null or a."body" #>> '{subject,principal,tenant}' = p_filter ->> 'tenant')
      and (p_filter ->> 'principalId' is null or a."body" #>> '{subject,principal,id}' = p_filter ->> 'principalId')
      and (p_filter ->> 'actorId' is null or a."body" #>> '{subject,actor,id}' = p_filter ->> 'actorId')
      and (p_filter ->> 'session' is null or a."body" #>> '{subject,session}' = p_filter ->> 'session')
    returning 1
  )
  select count(*)::integer from cancelled
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_consume (
  p_token text,
  p_now   text
)
  RETURNS jsonb
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  update "better_supabase"."approval_requests" a
  set "body" = a."body" || jsonb_build_object('consumedAt', p_now)
  where a."token" = p_token
    and a."body" ->> 'status' = 'approved'
    and a."body" ->> 'consumedAt' is null
    and (a."body" ->> 'expiresAt')::timestamptz > p_now::timestamptz
  returning a."body"
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_expire (
  p_now text
)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  with expired as (
    update "better_supabase"."approval_requests" a
    set "body" = a."body" || '{"status":"expired"}'::jsonb
    where a."body" ->> 'status' = 'pending' and (a."body" ->> 'expiresAt')::timestamptz <= p_now::timestamptz
    returning 1
  )
  select count(*)::integer from expired
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_get (
  p_token text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a."body" from "better_supabase"."approval_requests" a where a."token" = p_token
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_list (
  p_filter        jsonb,
  p_after_created text,
  p_after_token   text,
  p_limit         integer
)
  RETURNS SETOF jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select a."body"
  from "better_supabase"."approval_requests" a
  where a."body" is not null
    and (p_filter ->> 'status' is null or a."body" ->> 'status' = p_filter ->> 'status')
    and (p_filter ->> 'tenant' is null or a."body" #>> '{subject,principal,tenant}' = p_filter ->> 'tenant')
    and (p_filter ->> 'principalId' is null or a."body" #>> '{subject,principal,id}' = p_filter ->> 'principalId')
    and (p_filter ->> 'actorId' is null or a."body" #>> '{subject,actor,id}' = p_filter ->> 'actorId')
    and (p_filter ->> 'session' is null or a."body" #>> '{subject,session}' = p_filter ->> 'session')
    and (p_after_created is null
      or ((a."body" ->> 'createdAt') collate "C", a."token" collate "C") > (p_after_created collate "C", p_after_token collate "C"))
  order by (a."body" ->> 'createdAt') collate "C", a."token" collate "C"
  limit p_limit
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_open (
  p_request jsonb
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  insert into "better_supabase"."approval_requests" as a ("token", "body")
  select r."token", r."body"
  from pg_catalog.jsonb_populate_record(null::"better_supabase"."approval_requests", pg_catalog.jsonb_build_object('token', p_request ->> 'token', 'body', p_request)) r
  on conflict ("token") do update
    set "body" = excluded."body"
    where a."body" ->> 'status' = 'expired' or (a."body" ->> 'expiresAt')::timestamptz <= now()
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_approval_resolve (
  p_token text,
  p_next  jsonb,
  p_seen  integer
)
  RETURNS jsonb
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  update "better_supabase"."approval_requests" a
  set "body" = p_next
  where a."token" = p_token
    and a."body" ->> 'status' = 'pending'
    and (a."body" ->> 'expiresAt')::timestamptz > now()
    and coalesce(jsonb_array_length(a."body" -> 'approvals'), 0) = p_seen
  returning a."body"
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_bootstrap_permissions (
  p_tenant text DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  with pdk_k(key, n) as (
    select k.key, (k.n - 1)::integer
    from unnest(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.approve', 'quotes.create', 'quotes.delete', 'quotes.list', 'quotes.read', 'quotes.send', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[]) with ordinality as k(key, n)
  ),
  pdk_t(id) as (
    select t.id from "permdock".member_organization_ids() as t(id)
    where p_tenant is null or t.id::text = p_tenant
  ),
  pdk_p(n) as (
    select k.n from "permdock".permitted_organization_permission_keys(null::uuid) h(key) join pdk_k k on k.key = h.key
    where exists (
      select 1 from "permdock".permission_keys v
      where v.permission = k.key and v.scope = 'global' and v.effect = 'allow' and not v.conditioned
    )
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'apiVersion', 1,
    'form', 'compact',
    'keys', coalesce((select jsonb_agg(k.key order by k.n) from pdk_k k), '[]'::jsonb),
    'tenants', coalesce((
      select jsonb_object_agg(t.id::text, (select translate(encode(coalesce(decode(string_agg(lpad(to_hex(coalesce(b.v, 0)), 2, '0'), '' order by g.i), 'hex'), ''::bytea), 'base64'), '+/=' || chr(10), '-_')
      from generate_series(0, 6) g(i)
      left join (
        select x.n / 8 as i, sum(1 << (x.n % 8)) as v from (select k.n from "permdock".permitted_organization_permission_keys(t.id) h(key) join pdk_k k on k.key = h.key) x(n) group by 1
      ) b on b.i = g.i))
      from pdk_t t
    ), '{}'::jsonb),
    'platform', case when exists (select 1 from pdk_p) then (select translate(encode(coalesce(decode(string_agg(lpad(to_hex(coalesce(b.v, 0)), 2, '0'), '' order by g.i), 'hex'), ''::bytea), 'base64'), '+/=' || chr(10), '-_')
      from generate_series(0, 6) g(i)
      left join (
        select x.n / 8 as i, sum(1 << (x.n % 8)) as v from (select p.n from pdk_p p) x(n) group by 1
      ) b on b.i = g.i) end
  ))
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_cascade_custom_role()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_old_tenant uuid := old."organization_id"::uuid;
  v_old_scope text := case when old."organization_id"::uuid is null then 'global' else 'organization' end;
  v_old_id text := null::text;
  v_old_key text := old."key"::text;
  v_new_tenant uuid;
  v_new_scope text;
  v_new_id text;
  v_new_key text;
  v_checked boolean := coalesce((select "permdock".permdock_user_id())::text, '') <> '' and current_setting('permdock.sync', true) is distinct from 'on';
  v_allow text[];
  v_deny text[];
  v_include text[];
begin
  if (old."organization_id"::uuid is not null and coalesce(old."is_system", false)) then
    return null;
  end if;
  if tg_op = 'UPDATE' and not (new."organization_id"::uuid is not null and coalesce(new."is_system", false)) then
    v_new_tenant := new."organization_id"::uuid;
    v_new_scope := case when new."organization_id"::uuid is null then 'global' else 'organization' end;
    v_new_id := null::text;
    v_new_key := new."key"::text;
    if v_new_key = v_old_key
      and v_new_tenant is not distinct from v_old_tenant
      and v_new_scope = v_old_scope
      and v_new_id is not distinct from v_old_id then
      return null;
    end if;
  end if;
  if not exists (select 1 from "permdock".custom_role_permissions c where (v_old_tenant is null and c.tenant_id is null or c.tenant_id = v_old_tenant) and c.scope = v_old_scope and (v_old_id is null and c.scope_id is null or c.scope_id = v_old_id) and c.role = v_old_key)
    and not exists (select 1 from "permdock".custom_role_includes c where (v_old_tenant is null and c.tenant_id is null or c.tenant_id = v_old_tenant) and c.scope = v_old_scope and (v_old_id is null and c.scope_id is null or c.scope_id = v_old_id) and c.role = v_old_key) then
    return null;
  end if;
  if v_checked then
    perform "permdock".permdock_custom_role_guard(v_old_tenant, v_old_scope, v_old_id, v_old_key);
  end if;
  if v_new_key is null then
    perform set_config('permdock.sync', 'on', true);
    perform "permdock".permdock_trusted_delete_custom_role_grants(v_old_tenant, v_old_scope, v_old_id, v_old_key);
    delete from "permdock".custom_role_includes c
    where c.include_role = v_old_key
      and not (v_old_key = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]));
    perform set_config('permdock.sync', '', true);
    return null;
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where (v_new_tenant is null and c.tenant_id is null or c.tenant_id = v_new_tenant) and c.scope = v_new_scope and (v_new_id is null and c.scope_id is null or c.scope_id = v_new_id) and c.role = v_new_key)
    or exists (select 1 from "permdock".custom_role_includes c where (v_new_tenant is null and c.tenant_id is null or c.tenant_id = v_new_tenant) and c.scope = v_new_scope and (v_new_id is null and c.scope_id is null or c.scope_id = v_new_id) and c.role = v_new_key) then
    raise exception using
      errcode = '22023',
      hint = 'role-exists',
      message = 'permdock: ' || v_new_key || ' already has grants';
  end if;
  update "permdock".custom_role_permissions c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where (v_old_tenant is null and c.tenant_id is null or c.tenant_id = v_old_tenant) and c.scope = v_old_scope and (v_old_id is null and c.scope_id is null or c.scope_id = v_old_id) and c.role = v_old_key;
  update "permdock".custom_role_includes c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where (v_old_tenant is null and c.tenant_id is null or c.tenant_id = v_old_tenant) and c.scope = v_old_scope and (v_old_id is null and c.scope_id is null or c.scope_id = v_old_id) and c.role = v_old_key;
  if v_checked then
    perform "permdock".permdock_custom_role_guard(v_new_tenant, v_new_scope, v_new_id, v_new_key);
    select array_agg(c.permission) filter (where c.effect = 'allow'),
      array_agg(c.permission) filter (where c.effect = 'deny')
    into v_allow, v_deny
    from "permdock".custom_role_permissions c
    where (v_new_tenant is null and c.tenant_id is null or c.tenant_id = v_new_tenant) and c.scope = v_new_scope and (v_new_id is null and c.scope_id is null or c.scope_id = v_new_id) and c.role = v_new_key;
    select array_agg(c.include_role) into v_include
    from "permdock".custom_role_includes c
    where (v_new_tenant is null and c.tenant_id is null or c.tenant_id = v_new_tenant) and c.scope = v_new_scope and (v_new_id is null and c.scope_id is null or c.scope_id = v_new_id) and c.role = v_new_key;
    perform "permdock".permdock_custom_role_entries(v_new_scope, v_allow, v_deny, v_include);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_beyond (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_allow    text[],
  p_deny     text[],
  p_include  text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if false then
    return;
  end if;
  return query
  with resolved as (
    select distinct rp.permission, k.key as grant_key
    from "permdock".permdock_custom_keys(p_allow, p_deny, p_include, p_scope) k(key)
    join "permdock".role_permissions rp on rp.grant_key = k.key and rp.effect = 'allow'
  ),
  held as (
    select distinct rp.permission, rp.grant_key
    from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission in (select r.permission from resolved r)
      and ("permdock".permdock_has(rp.grant_key)
        or (p_scope <> 'global'
          and (p_tenant::text in (select x::text from "permdock".permitted_organization_ids(rp.grant_key) x)
            or (case p_scope when 'organization' then false when 'team' then p_scope_id in (select x::text from "permdock".permitted_team_ids(rp.grant_key) x) when 'customer' then p_scope_id in (select x::text from "permdock".permitted_customer_ids(rp.grant_key) x) else false end))))
  )
  select distinct r.permission
  from resolved r
  where not exists (select 1 from held h where h.permission = r.permission);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_entries (
  p_scope   text,
  p_allow   text[],
  p_deny    text[],
  p_include text[]
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_entry text;
  v_key text;
  v_problem text;
begin
  foreach v_entry in array coalesce(p_allow, '{}'::text[]) loop
    v_key := v_entry;
    v_problem := "permdock".permdock_custom_role_entry_problem(p_scope, v_entry);
    if v_problem = 'unknown-permission' then
      raise exception using
        errcode = '22023',
        hint = 'unknown-permission',
        message = 'permdock: ' || v_entry || ' is not a declared permission';
    end if;
    if v_problem = 'outside-ceiling' then
      raise exception using
        errcode = '22023',
        hint = 'outside-ceiling',
        message = 'permdock: ' || v_key || ' is outside the ceiling of ' || p_scope;
    end if;
  end loop;
  foreach v_entry in array coalesce(p_deny, '{}'::text[]) loop
    if not (v_entry = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.approve', 'quotes.create', 'quotes.delete', 'quotes.list', 'quotes.read', 'quotes.send', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])) then
      raise exception using
        errcode = '22023',
        hint = 'unknown-permission',
        message = 'permdock: ' || v_entry || ' is not a declared permission';
    end if;
  end loop;
  foreach v_entry in array coalesce(p_include, '{}'::text[]) loop
    if not (v_entry = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[])) then
      raise exception using
        errcode = '22023',
        hint = 'unknown-role',
        message = 'permdock: ' || v_entry || ' is not a declared role';
    end if;
  end loop;
  select string_agg(distinct rp.permission, ', ') into v_key
  from "permdock".role_permissions rp
  where rp.role = any(coalesce(p_include, '{}'::text[]))
    and rp.effect = 'allow'
    and not exists (
      select 1 from "permdock".permdock_ceiling c
      where c.scope = p_scope and c.effect = 'allow' and c.permission = rp.permission
    );
  if v_key is not null then
    raise exception using
      errcode = '22023',
      hint = 'outside-ceiling',
      message = 'permdock: an included role allows ' || v_key || ', outside the ceiling of ' || p_scope;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_entry_problem (
  p_scope text,
  p_entry text
)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_key text := p_entry;
begin
  if p_entry is null or not (v_key = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.approve', 'quotes.create', 'quotes.delete', 'quotes.list', 'quotes.read', 'quotes.send', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])) then
    return 'unknown-permission';
  end if;
  if not exists (
    select 1 from "permdock".permdock_ceiling c
    where c.scope = p_scope and c.effect = 'allow' and c.permission = v_key
  ) then
    return 'outside-ceiling';
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_guard (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_beyond text;
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '' and (
    false
    or (p_scope <> 'global' and coalesce(p_tenant::text in (select x::text from "permdock".member_organization_ids() x)
      or (case p_scope when 'organization' then false when 'team' then p_scope_id in (select x::text from "permdock".member_team_ids() x) when 'customer' then p_scope_id in (select x::text from "permdock".member_customer_ids() x) else false end), false))
  )) then
    raise exception using
      errcode = '42501',
      hint = 'not-member',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform');
  end if;
  if not exists (
    select 1 from "permdock".role_permissions rp
    where rp.effect = 'allow'
      and rp.permission = any(array['roles.manage']::text[])
      and ("permdock".permdock_has(rp.grant_key)
        or (p_scope <> 'global'
          and (p_tenant::text in (select x::text from "permdock".permitted_organization_ids(rp.grant_key) x)
            or (case p_scope when 'organization' then false when 'team' then p_scope_id in (select x::text from "permdock".permitted_team_ids(rp.grant_key) x) when 'customer' then p_scope_id in (select x::text from "permdock".permitted_customer_ids(rp.grant_key) x) else false end))))
  ) then
    raise exception using
      errcode = '42501',
      hint = 'manage-roles',
      message = 'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform');
  end if;
  select array_agg(permission) filter (where c.effect = 'allow'),
    array_agg(c.permission) filter (where c.effect = 'deny')
  into v_allow, v_deny
  from "permdock".custom_role_permissions c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where case when "permdock".permdock_is_shared_role(p_scope, p_role) then c.tenant_id is null else (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) end and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from "permdock".permdock_custom_role_beyond(p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
    raise exception using
      errcode = '42501',
      hint = 'not-assignable-by',
      message = 'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_name_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if new."organization_id"::uuid is null or coalesce(new."is_system", false) then
    return new;
  end if;
  if new."key"::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || new."key"::text || ' is a declared role';
  end if;
  if "permdock".permdock_is_shared_role(case when new."organization_id"::uuid is null then 'global' else 'organization' end, new."key"::text) then
    raise exception using
      errcode = '22023',
      hint = 'name-taken',
      message = 'permdock: ' || new."key"::text || ' is a shared role';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_custom_role_shape (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_role     text
)
  RETURNS void
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
begin
  if p_scope = 'global' then
    if p_tenant is not null or p_scope_id is not null then
      raise exception using
        errcode = '22023',
        hint = 'unknown-scope',
        message = 'permdock: a platform custom role has no tenant or instance';
    end if;
  elsif not (p_scope = any(array['organization', 'team', 'customer']::text[])) then
    raise exception using
      errcode = '22023',
      hint = 'unknown-scope',
      message = 'permdock: custom roles are held at a scope of a tenant or at global, not ' || coalesce(p_scope, 'null');
  elsif p_tenant is null and p_scope_id is not null then
    raise exception using
      errcode = '22023',
      hint = 'unknown-scope',
      message = 'permdock: a shared custom role has no instance';
  end if;
  if coalesce(p_role, '') = '' or p_role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(p_role, 'null') || ' is not a custom role name';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has (
  p_grant text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select "permdock".permdock_api_key_allows(p_grant) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null and coalesce((
  select exists (
    select 1
    from "permdock".user_roles ur
    cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
    where ur.user_id = (select "permdock".permdock_user_id())
      and rp.grant_key = p_grant
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = (select "permdock".permdock_user_id())
      and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
      and p_grant in (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key))
  )
  ), false)
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_has_for (
  p_user  uuid,
  p_grant text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select exists (
    select 1
    from "permdock".user_roles ur
    cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
    where ur.user_id = p_user
      and rp.grant_key = p_grant
  )
  or exists (
    select 1
    from "permdock".user_roles ur
    where ur.user_id = p_user
      and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
      and p_grant in (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key))
  )
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_permission_keys()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select k.permission from unnest(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.approve', 'quotes.create', 'quotes.delete', 'quotes.list', 'quotes.read', 'quotes.send', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[]) k(permission) order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_permission_keys (
  p_scope text
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select distinct rp.permission
  from "permdock".role_permissions rp
  where rp.scope = p_scope
    and rp.effect = 'allow'
    and rp.permission = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.approve', 'quotes.create', 'quotes.delete', 'quotes.list', 'quotes.read', 'quotes.send', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])
  order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_rename_custom_role_grants (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_from     text,
  p_to       text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform "permdock".permdock_custom_role_guard(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      hint = 'name-taken',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to) then
    raise exception using
      errcode = '22023',
      hint = 'role-exists',
      message = 'permdock: ' || p_to || ' already has grants';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_replace_custom_role_grants_by_id (
  p_role_id     uuid,
  p_permissions text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'organization' end, null::text, r."key"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      hint = 'unknown-role',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null');
  end if;
  if v_skipped or v_key = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where (v_tenant is null and c.tenant_id is null or c.tenant_id = v_tenant) and c.scope = v_scope and (v_scope_id is null and c.scope_id is null or c.scope_id = v_scope_id) and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where (v_tenant is null and c.tenant_id is null or c.tenant_id = v_tenant) and c.scope = v_scope and (v_scope_id is null and c.scope_id is null or c.scope_id = v_scope_id) and c.role = v_key;
  perform "permdock".permdock_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "source" => 'permdock');
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_role_in (
  p_role   text,
  p_tenant uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select p_role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[])
    or exists (select 1 from "public"."roles" r where r."key"::text = p_role and (r."organization_id" = p_tenant or r."organization_id" is null))
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_role_permissions (
  p_role     text,
  p_scope    text,
  p_tenant   uuid DEFAULT NULL::uuid,
  p_scope_id text DEFAULT NULL::text
)
  RETURNS TABLE (
    permission text,
    effect     text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if p_role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]) then
    return query
  select distinct rp.permission, rp.effect
  from "permdock".role_permissions rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2;
    return;
  end if;
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '' and (
    false
    or (p_scope <> 'global' and p_tenant is null and p_scope_id is null)
    or (p_scope <> 'global' and (p_tenant::text in (select x::text from "permdock".member_organization_ids() x)
      or (case p_scope when 'organization' then false when 'team' then p_scope_id in (select x::text from "permdock".member_team_ids() x) when 'customer' then p_scope_id in (select x::text from "permdock".member_customer_ids() x) else false end)))
  )) then
    raise exception using
      errcode = '42501',
      hint = 'not-member',
      message = 'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform');
  end if;
  return query
  select distinct rp.permission, rp.effect
  from "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role),
    p_scope
  ) k(grant_key)
  join "permdock".role_permissions rp on rp.grant_key = k.grant_key and rp.scope = p_scope
  order by 1, 2;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_sync_custom_role_guard_permissions()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v record;
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_lost text[];
  v_dropped text[];
  v_beyond text;
  v_refs text[] := array[
    case when tg_op <> 'INSERT' then old."role_id"::text end,
    case when tg_op <> 'DELETE' then new."role_id"::text end
  ];
begin
  if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '') or current_setting('permdock.sync', true) = 'on' then
    return coalesce(new, old);
  end if;
  for v in
    select r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role, r."id" as permissions_ref
    from "public"."roles" r
    where not (r."organization_id"::uuid is not null and coalesce(r."is_system", false)) and not (r."key"::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[])) and r."id"::text = any(v_refs)
  loop
    if v.role is null or not (v.scope = 'global' or v.scope = any(array['organization', 'team', 'customer']::text[])) then
      continue;
    end if;
    if v.tenant_id is not null and "permdock".permdock_is_shared_role(v.scope, v.role) then
      continue;
    end if;
    perform "permdock".permdock_custom_role_guard(v.tenant_id, v.scope, v.scope_id, v.role);
    if tg_op = 'DELETE' then
      continue;
    end if;
    v_dropped := '{}'::text[];
    with raw as (
      select x."permission"::text as legacy, 'allow' as effect, null::text as level
      from (select new.*) x
      where x."role_id" = v.permissions_ref
    ),
    mapped as (
      select n.legacy, n.legacy as key, n.effect, n.level
      from raw n
    ),
    judged as (
      select m.legacy, m.key, m.effect, m.level as level, case
          when m.effect not in ('allow', 'deny') then 'effect ' || m.effect || ' is not allow or deny'
          when m.key is null or not (m.key = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.approve', 'quotes.create', 'quotes.delete', 'quotes.list', 'quotes.read', 'quotes.send', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])) then 'not a declared permission'
          when m.effect = 'allow' and not exists (select 1 from "permdock".permdock_ceiling c where c.scope = v.scope and c.effect = 'allow' and c.permission = m.key) then 'outside the ceiling of ' || v.scope
        end as dropped
      from mapped m
    )
    select array_agg(distinct j.key) filter (where j.dropped is null and j.effect = 'allow'),
      array_agg(distinct j.key) filter (where j.dropped is null and j.effect = 'deny'),
      array_agg(v.role || ': ' || coalesce(j.legacy, 'null') || ', ' || j.dropped) filter (where j.dropped is not null)
    into v_allow, v_deny, v_lost
    from judged j;
    v_dropped := v_dropped || coalesce(v_lost, '{}'::text[]);
    v_include := null;
    if cardinality(v_dropped) > 0 then
      raise exception using
        errcode = '22023',
        hint = case
          when v_dropped[1] like '%outside the ceiling of %' then 'outside-ceiling'
          when v_dropped[1] like '%, level % is not declared' then 'unknown-level'
          when v_dropped[1] like '%, not a declared role' then 'unknown-role'
          else 'unknown-permission'
        end,
        message = 'permdock: ' || v_dropped[1];
    end if;
    select string_agg(b, ', ' order by b) into v_beyond
    from "permdock".permdock_custom_role_beyond(v.tenant_id, v.scope, v.scope_id, v_allow, v_deny, v_include) b;
    if v_beyond is not null then
      raise exception using
        errcode = '42501',
        hint = 'not-assignable-by',
        message = 'permdock: ' || v.role || ' would allow ' || v_beyond || ', which the caller may not hand out';
    end if;
  end loop;
  return coalesce(new, old);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_sync_custom_role_permissions()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v record;
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_lost text[];
  v_dropped text[];
  v_refs text[] := array[
    case when tg_op <> 'INSERT' then old."role_id"::text end,
    case when tg_op <> 'DELETE' then new."role_id"::text end
  ];
begin
  for v in
    select r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role, r."id" as permissions_ref
    from "public"."roles" r
    where not (r."organization_id"::uuid is not null and coalesce(r."is_system", false)) and not (r."key"::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[])) and r."id"::text = any(v_refs)
  loop
    if v.role is null or not (v.scope = 'global' or v.scope = any(array['organization', 'team', 'customer']::text[])) then
      raise warning 'permdock sync: % has scope %, which is not declared', coalesce(v.role, 'null'), coalesce(v.scope, 'null');
      continue;
    end if;
    if v.tenant_id is not null and "permdock".permdock_is_shared_role(v.scope, v.role) then
      raise warning 'permdock sync: % is the name of a shared custom role (name-taken); the legacy write is not copied', v.role;
      continue;
    end if;
    v_dropped := '{}'::text[];
    with raw as (
      select x."permission"::text as legacy, 'allow' as effect, null::text as level
      from "public"."role_permissions" x
      where x."role_id" = v.permissions_ref
    ),
    mapped as (
      select n.legacy, n.legacy as key, n.effect, n.level
      from raw n
    ),
    judged as (
      select m.legacy, m.key, m.effect, m.level as level, case
          when m.effect not in ('allow', 'deny') then 'effect ' || m.effect || ' is not allow or deny'
          when m.key is null or not (m.key = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.approve', 'quotes.create', 'quotes.delete', 'quotes.list', 'quotes.read', 'quotes.send', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])) then 'not a declared permission'
          when m.effect = 'allow' and not exists (select 1 from "permdock".permdock_ceiling c where c.scope = v.scope and c.effect = 'allow' and c.permission = m.key) then 'outside the ceiling of ' || v.scope
        end as dropped
      from mapped m
    )
    select array_agg(distinct j.key) filter (where j.dropped is null and j.effect = 'allow'),
      array_agg(distinct j.key) filter (where j.dropped is null and j.effect = 'deny'),
      array_agg(v.role || ': ' || coalesce(j.legacy, 'null') || ', ' || j.dropped) filter (where j.dropped is not null)
    into v_allow, v_deny, v_lost
    from judged j;
    v_dropped := v_dropped || coalesce(v_lost, '{}'::text[]);
    v_include := null;
    v_include := array(select c.include_role from "permdock".custom_role_includes c where (v.tenant_id is null and c.tenant_id is null or c.tenant_id = v.tenant_id) and c.scope = v.scope and (v.scope_id is null and c.scope_id is null or c.scope_id = v.scope_id) and c.role = v.role);
    perform set_config('permdock.sync', 'on', true);
    perform "permdock".permdock_trusted_replace_custom_role_grants(v.tenant_id, v.scope, v.scope_id, v.role, v_allow, v_deny, v_include);
    perform set_config('permdock.sync', '', true);
    if cardinality(v_dropped) > 0 then
      raise warning 'permdock sync: dropped % entr(ies) PermDock cannot hold: %', cardinality(v_dropped), (select string_agg(g.role || ': ' || g.items, '; ' order by g.role)
    from (
      select split_part(l.d, ': ', 1) as role, string_agg(substr(l.d, strpos(l.d, ': ') + 2), ', ' order by l.d) as items
      from (select u.d from unnest(v_dropped) as u(d) order by u.d limit 50) l
      group by 1
    ) g);
    end if;
  end loop;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_rename_custom_role_grants (
  p_tenant   uuid,
  p_scope    text,
  p_scope_id text,
  p_from     text,
  p_to       text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_from);
  if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then
    raise exception using
      errcode = '22023',
      hint = 'name-taken',
      message = 'permdock: ' || p_to || ' is the name of a shared custom role';
  end if;
  if coalesce(p_to, '') = '' or p_to = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name';
  end if;
  if exists (select 1 from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to)
    or exists (select 1 from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_to) then
    raise exception using
      errcode = '22023',
      hint = 'role-exists',
      message = 'permdock: ' || p_to || ' already has grants';
  end if;
  update "permdock".custom_role_permissions c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
  update "permdock".custom_role_includes c set role = p_to where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_from;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_replace_custom_role_grants_by_id (
  p_role_id     uuid,
  p_permissions text[]
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_tenant uuid;
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select r."organization_id"::uuid, case when r."organization_id"::uuid is null then 'global' else 'organization' end, null::text, r."key"::text, (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from "public"."roles" r
  where r."id" = p_role_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      hint = 'unknown-role',
      message = 'permdock: no role row has id ' || coalesce(p_role_id::text, 'null');
  end if;
  if v_skipped or v_key = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]) then
    raise exception using
      errcode = '22023',
      hint = 'declared-role',
      message = 'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role';
  end if;
  select array_agg(c.permission) into v_deny
  from "permdock".custom_role_permissions c
  where (v_tenant is null and c.tenant_id is null or c.tenant_id = v_tenant) and c.scope = v_scope and (v_scope_id is null and c.scope_id is null or c.scope_id = v_scope_id) and c.role = v_key and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from "permdock".custom_role_includes c
  where (v_tenant is null and c.tenant_id is null or c.tenant_id = v_tenant) and c.scope = v_scope and (v_scope_id is null and c.scope_id is null or c.scope_id = v_scope_id) and c.role = v_key;
  perform "permdock".permdock_trusted_replace_custom_role_grants(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);
  perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "source" => 'permdock');
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_role_permissions (
  p_role     text,
  p_scope    text,
  p_tenant   uuid DEFAULT NULL::uuid,
  p_scope_id text DEFAULT NULL::text
)
  RETURNS TABLE (
    permission text,
    effect     text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if p_role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]) then
    return query
  select distinct rp.permission, rp.effect
  from "permdock".role_permissions rp
  where rp.role = p_role and rp.scope = p_scope
  order by 1, 2;
    return;
  end if;
  perform "permdock".permdock_custom_role_shape(p_tenant, p_scope, p_scope_id, p_role);
  return query
  select distinct rp.permission, rp.effect
  from "permdock".permdock_custom_keys(
    array(select c.permission from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role and c.effect = 'allow'),
    array(select c.permission from "permdock".custom_role_permissions c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role and c.effect = 'deny'),
    array(select c.include_role from "permdock".custom_role_includes c where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and (p_scope_id is null and c.scope_id is null or c.scope_id = p_scope_id) and c.role = p_role),
    p_scope
  ) k(grant_key)
  join "permdock".role_permissions rp on rp.grant_key = k.grant_key and rp.scope = p_scope
  order by 1, 2;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permdock_trusted_role_permissions_by_id (
  p_role_ids text[],
  p_tenant   uuid   DEFAULT NULL::uuid
)
  RETURNS TABLE (
    role_id    text,
    permission text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if p_tenant is not null and exists (
    select 1 from "public"."roles" r
    where r."id"::text = any(p_role_ids) and r."organization_id"::uuid is distinct from p_tenant
  ) then
    raise exception using
      errcode = '42501',
      hint = 'not-member',
      message = 'permdock: a role id belongs to another tenant than ' || p_tenant::text;
  end if;
  return query
  select distinct v.role_id, c.permission
  from (
    select r."id"::text as role_id, r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role
    from "public"."roles" r
    where r."id"::text = any(p_role_ids)
      and not (r."organization_id"::uuid is not null and coalesce(r."is_system", false))
      and not (r."key"::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) v
  join "permdock".custom_role_permissions c
    on (v.tenant_id is null and c.tenant_id is null or c.tenant_id = v.tenant_id)
    and c.scope = v.scope
    and (v.scope_id is null and c.scope_id is null or c.scope_id = v.scope_id)
    and c.role = v.role
  where c.effect = 'allow'
    and c.permission = any(array['access_requests.create', 'access_requests.emergency', 'access_requests.manage', 'access_requests.read', 'access_requests.review', 'api_keys.manage', 'api_keys.own', 'approvals.manage', 'approvals.read', 'approvals.request', 'audit.read', 'audit.revert', 'automations.manage', 'automations.publish', 'automations.read', 'automations.write', 'billing.read', 'impersonation.read', 'impersonation.revoke', 'impersonation.start', 'members.invite', 'members.read', 'members.remove', 'members.update_role', 'organization.delete', 'organization.transfer_ownership', 'organization.update', 'quotes.approve', 'quotes.create', 'quotes.delete', 'quotes.list', 'quotes.read', 'quotes.send', 'quotes.update', 'relations.manage', 'relations.read', 'roles.manage', 'service_accounts.manage', 'service_accounts.read', 'settings.manage', 'settings.read', 'settings.update', 'sso.manage', 'staff.list', 'staff.read', 'teams.manage', 'teams.read', 'usage.read', 'usage.record']::text[])
  order by 1, 2;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select ids.id
  from (
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.keys
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  )
  select (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys)
  ) ids(id)
  where (select "permdock".permdock_api_key_allows(p_grant));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_ids_for (
  p_user  uuid,
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.keys
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  )
  select (ms.id)::uuid
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and rp.grant_key = p_grant
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'customer')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
  from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys (
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'customer')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
  from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.within ->> 'organization' = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.within ->> 'organization')::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'customer')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_customer_permission_keys_for (
  p_user uuid,
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."contacts"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'customer')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('customer', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'customer'::text as scope, m."customer_id"::text as id, jsonb_build_object('organization', m."organization_id"::text) as within, jsonb_build_array('contact') as roles, 'contact'::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."contacts" m
    where m."user_id" = v_user_0
    group by m."customer_id", m."organization_id"
    having jsonb_build_array('contact') is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('customer', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.within ->> 'organization')::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'customer' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'customer'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'customer' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'customer' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  select ids.id
  from (
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.keys
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  )
  select (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys)
  union
  select (k ->> 'tenant')::uuid
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where jsonb_typeof(k) = 'object'
    and coalesce((select "permdock".permdock_user_id())::text, '') = ''
    and coalesce(k ->> 'tenant', '') <> ''
    and rp.grant_key = p_grant
    and rp.scope = 'organization'
  ) ids(id)
  where (select "permdock".permdock_api_key_allows(p_grant));
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_ids_for (
  p_user  uuid,
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m as (
  select (ms.id)::uuid as id, pdk_e.keys
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  )
  select (ms.id)::uuid
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and rp.grant_key = p_grant
  union
  select pdk_m.id from pdk_m
  where p_grant = any(pdk_m.keys);
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'organization')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
  from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select (k ->> 'tenant')::uuid, rp.grant_key
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where jsonb_typeof(k) = 'object'
    and coalesce((select "permdock".permdock_user_id())::text, '') = ''
    and coalesce(k ->> 'tenant', '') <> ''
    and rp.scope = 'organization'
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys (
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := (select "permdock".permdock_user_id());
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'organization')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
  from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where coalesce((select "permdock".permdock_user_id())::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    and (nullif(((select auth.jwt()) ->> 'tenant_id'), '') is null or ms.id = nullif(((select auth.jwt()) ->> 'tenant_id'), ''))
    and (nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null or (ms.id)::text = nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', ''))
  union
  select (k ->> 'tenant')::uuid, rp.grant_key
  from (select ((select auth.jwt()) -> 'api_key') as k) api_key
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '[]'::jsonb end
  ) r(role)
  join "permdock".role_permissions rp on rp.role = r.role
  where jsonb_typeof(k) = 'object'
    and coalesce((select "permdock".permdock_user_id())::text, '') = ''
    and coalesce(k ->> 'tenant', '') <> ''
    and rp.scope = 'organization'
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'organization')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_organization_permission_keys_for (
  p_user uuid,
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
declare
  v_user_0 "public"."organization_memberships"."user_id"%type := p_user;
begin
  return query
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'organization')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select (ms.id)::uuid, rp.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral "permdock".permdock_role_grant_keys('organization', r.role) rp(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
  union
  select (ms.id)::uuid, ck.grant_key
  from (
    select 'organization'::text as scope, m."organization_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
    from "public"."organization_memberships" m
    where m."user_id" = v_user_0
    group by m."organization_id"
    having jsonb_agg(distinct m."role"::text order by m."role"::text) filter (where m."role"::text is not null) is not null
  ) ms
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
  ) r(role)
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select "permdock".permdock_is_shared_role('organization', r.role) as shared offset 0) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where (not pdk_s.shared and c.tenant_id = (ms.id)::uuid or pdk_s.shared and c.tenant_id is null) and c.scope = 'organization' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where coalesce(p_user::text, '') <> ''
    and ms.scope = 'organization'
    and not (r.role = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'organization' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'organization' and pdk_h.effect = 'deny'))
  order by 1;
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_match (
  p_row        public.quotes,
  p_permission text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
begin
  return (
  with permdock_candidates as (select (p_row).*),
  permdock_hoisted as materialized (
    select
    coalesce((((select auth.jwt()) -> 'api_key')) is null or (((select auth.jwt()) -> 'api_key')) = 'null'::jsonb, false) as key_unlimited
  )
  select exists (select 1 from permdock_candidates, permdock_hoisted where case p_permission
    when 'quotes.create' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.create')))), false)
    when 'quotes.delete' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.delete')))) and ("status" = 'draft')), false)
    when 'quotes.list' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list')))) or ((permdock_hoisted.key_unlimited or (select "permdock".permdock_api_key_allows('quotes.list'))) and ("customer_id" = any(array(select "permdock".member_customer_ids()))))), false)
    when 'quotes.read' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read'))))), false)
    when 'quotes.send' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.send')))) and ("status" = 'draft')), false)
    when 'quotes.update' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update')))), false)
    else false
  end)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_rows (
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  with permdock_hoisted as materialized (
    select
    coalesce((((select auth.jwt()) -> 'api_key')) is null or (((select auth.jwt()) -> 'api_key')) = 'null'::jsonb, false) as key_unlimited
  )
  select "id"::uuid from "public"."quotes" as permdock_row, permdock_hoisted
  where case p_permission
    when 'quotes.create' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.create')))), false)
    when 'quotes.delete' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.delete')))) and ("status" = 'draft')), false)
    when 'quotes.list' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list')))) or ((permdock_hoisted.key_unlimited or (select "permdock".permdock_api_key_allows('quotes.list'))) and ("customer_id" = any(array(select "permdock".member_customer_ids()))))), false)
    when 'quotes.read' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read'))))), false)
    when 'quotes.send' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.send')))) and ("status" = 'draft')), false)
    when 'quotes.update' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update')))), false)
    else "permdock".permitted_quotes_match(permdock_row, p_permission)
  end
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_quotes_rows (
  p_permission text,
  p_tenant     uuid
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  with permdock_hoisted as materialized (
    select
    coalesce((((select auth.jwt()) -> 'api_key')) is null or (((select auth.jwt()) -> 'api_key')) = 'null'::jsonb, false) as key_unlimited
  )
  select "id"::uuid from "public"."quotes" as permdock_row, permdock_hoisted
  where permdock_row."organization_id" = p_tenant
    and case p_permission
    when 'quotes.create' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.create')))), false)
    when 'quotes.delete' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.delete')))) and ("status" = 'draft')), false)
    when 'quotes.list' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.list')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.list')))) or ((permdock_hoisted.key_unlimited or (select "permdock".permdock_api_key_allows('quotes.list'))) and ("customer_id" = any(array(select "permdock".member_customer_ids()))))), false)
    when 'quotes.read' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.read')))) or ("customer_id" = any(array(select "permdock".permitted_customer_ids('quotes.read'))))), false)
    when 'quotes.send' then coalesce((("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.send')))) and ("status" = 'draft')), false)
    when 'quotes.update' then coalesce(("organization_id" = any(array(select "permdock".permitted_organization_ids('quotes.update')))), false)
    else "permdock".permitted_quotes_match(permdock_row, p_permission)
  end
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_id_array (
  p_grant text
)
  RETURNS uuid[]
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  AS $function$
  select coalesce(array_agg(i), '{}'::uuid[]) from "permdock".permitted_team_ids(p_grant) i
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_ids (
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select ids.id
  from (
  select null::uuid where false -- no team memberships table configured
  ) ids(id)
  where (select "permdock".permdock_api_key_allows(p_grant))
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_ids_by_permission (
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'team') g(grant_key)
  cross join lateral "permdock".permitted_team_ids(g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'team', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_team_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_ids_by_permission (
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'team') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'team', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_team_ids(g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'team', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'team', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_team_ids(g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_ids_by_permission_for (
  p_user       uuid,
  p_permission text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from "permdock".grant_keys(p_permission, 'team') g(grant_key)
  cross join lateral "permdock".permitted_team_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from "permdock".grant_keys(p_permission, 'team', 'deny') g(grant_key)
  cross join lateral "permdock".permitted_team_ids_for(p_user, g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_ids_by_permission_for (
  p_user        uuid,
  p_permission  text,
  p_conditioned boolean
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select a.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'team') g(grant_key)
    union all
    select g.grant_key from "permdock".grant_keys(p_permission, 'team', 'conditioned-allow') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_team_ids_for(p_user, g.grant_key) a(id)
  except
  select d.id
  from (
    select g.grant_key from "permdock".grant_keys(p_permission, 'team', 'deny') g(grant_key)
    except
    select g.grant_key from "permdock".grant_keys(p_permission, 'team', 'conditioned-deny') g(grant_key)
    where p_conditioned
  ) g
  cross join lateral "permdock".permitted_team_ids_for(p_user, g.grant_key) d(id)
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_ids_for (
  p_user  uuid,
  p_grant text
)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  ROWS 10
  SET search_path TO ''
  AS $function$
  select null::uuid where false -- no team memberships table configured
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_permission_keys (
  p_id uuid
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'team')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
  from (
  select null::uuid, null::text where false -- no team memberships table configured
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'team' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'deny'))
  order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_permission_keys (
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'team')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select g.grant_key
  from (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = (select "permdock".permdock_user_id())
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ) g(grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(g.grant_key))) and (coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb)) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select ids.id, ids.grant_key
  from (
  select null::uuid, null::text where false -- no team memberships table configured
  ) ids(id, grant_key)
  where ((select ((((select auth.jwt()) -> 'api_key') is null or ((select auth.jwt()) -> 'api_key') = 'null'::jsonb) and coalesce(((select auth.jwt()) ->> 'client_id'), '') = '' and (((select auth.jwt()) -> 'act') is null or ((select auth.jwt()) -> 'act') = 'null'::jsonb))) or ("permdock".permdock_api_key_allows(ids.grant_key)))
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'team' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'deny'))
  order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_permission_keys_for (
  p_user uuid,
  p_id   uuid
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'team')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select null::uuid, null::text where false -- no team memberships table configured
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'team' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'deny'))
  order by 1
$function$;

CREATE OR REPLACE FUNCTION permdock.permitted_team_permission_keys_for (
  p_user uuid,
  p_id   uuid,
  p_keys text[]
)
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
  SECURITY DEFINER
  COST 1000
  SET search_path TO ''
  SET jit TO 'off'
  AS $function$
  with pdk_m(key, scope, effect, grant_key) as (
    select k.permission, k.scope, k.effect, k.grant_key
    from "permdock".permission_keys k
    where not k.conditioned and k.scope in ('global', 'team')
  ),
  pdk_w as (
    select pdk_m.key, pdk_m.scope, pdk_m.effect, pdk_m.grant_key
    from pdk_m
    where pdk_m.key in (select k.key from pg_catalog.unnest(p_keys) k(key))
  ),
  pdk_g as (
  select rp.grant_key
  from "permdock".user_roles ur
  cross join lateral "permdock".permdock_role_grant_keys('global', ur.role::text) rp(grant_key)
  where ur.user_id = p_user
  union
  select ck.grant_key
  from "permdock".user_roles ur
  cross join lateral (select k.grant_key
      from (select c.grant_keys as keys
        from (select false as shared) pdk_s
        cross join lateral (
          select c.grant_keys from "permdock".custom_role_compiled c
          where c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text
          order by c.scope_id nulls last
          limit 1
        ) c) pdk_e
      cross join lateral unnest(pdk_e.keys) k(grant_key)) ck(grant_key)
  where ur.user_id = p_user
    and not (ur.role::text = any(array['admin', 'contact', 'guest', 'lead', 'member', 'owner']::text[]))
  ),
  pdk_s as (
    select pdk_i.grant_key
    from (
  select null::uuid, null::text where false -- no team memberships table configured
    ) pdk_i(id, grant_key)
    where pdk_i.id = p_id
  ),
  pdk_h as (
    select pdk_w.key, pdk_w.scope, pdk_w.effect
    from pdk_w
    where (pdk_w.scope = 'global' and pdk_w.grant_key in (select pdk_g.grant_key from pdk_g))
      or (pdk_w.scope = 'team' and pdk_w.grant_key in (select pdk_s.grant_key from pdk_s))
  )
  select pdk_k.key
  from (select distinct pdk_w.key from pdk_w where pdk_w.effect = 'allow') pdk_k
  where (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'global' and pdk_h.effect = 'deny'))
    or (exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'allow') and not exists (select 1 from pdk_h where pdk_h.key = pdk_k.key and pdk_h.scope = 'team' and pdk_h.effect = 'deny'))
  order by 1
$function$;

ALTER TABLE "better_supabase"."api_keys"
  ADD CONSTRAINT "api_keys_rotated_from_fkey" FOREIGN KEY (rotated_from) REFERENCES better_supabase.api_keys(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."api_keys"
  ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."access_requests"
  ADD CONSTRAINT "access_requests_approval_id_fkey" FOREIGN KEY (approval_id) REFERENCES better_supabase.approval_requests(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."approval_decisions"
  ADD CONSTRAINT "approval_decisions_request_id_fkey" FOREIGN KEY (request_id) REFERENCES better_supabase.approval_requests(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."approval_items"
  ADD CONSTRAINT "approval_items_request_id_fkey" FOREIGN KEY (request_id) REFERENCES better_supabase.approval_requests(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."automation_evaluations"
  ADD CONSTRAINT "automation_evaluations_rule_id_fkey" FOREIGN KEY (rule_id) REFERENCES better_supabase.automations(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."automation_versions"
  ADD CONSTRAINT "automation_versions_rule_id_fkey" FOREIGN KEY (rule_id) REFERENCES better_supabase.automations(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."invitations"
  ADD CONSTRAINT "invitations_accepted_by_fkey" FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."invitations"
  ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."organizations"
  ADD CONSTRAINT "organizations_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."invitations"
  ADD CONSTRAINT "invitations_organization_fkey" FOREIGN KEY (tenant_id) REFERENCES better_supabase.organizations(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."scim_group_members"
  ADD CONSTRAINT "scim_group_members_group_id_fkey" FOREIGN KEY (group_id) REFERENCES better_supabase.scim_groups(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."scim_group_members"
  ADD CONSTRAINT "scim_group_members_scim_user_id_fkey" FOREIGN KEY (scim_user_id) REFERENCES better_supabase.scim_users(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."scim_users"
  ADD CONSTRAINT "scim_users_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."service_principals"
  ADD CONSTRAINT "service_principals_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."service_principals"
  ADD CONSTRAINT "service_principals_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."ssf_events"
  ADD CONSTRAINT "ssf_events_stream_id_fkey" FOREIGN KEY (stream_id) REFERENCES better_supabase.ssf_streams(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."support_requests"
  ADD CONSTRAINT "support_requests_admin_id_fkey" FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."support_requests"
  ADD CONSTRAINT "support_requests_approved_by_fkey" FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."support_requests"
  ADD CONSTRAINT "support_requests_target_id_fkey" FOREIGN KEY (target_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."support_sessions"
  ADD CONSTRAINT "support_sessions_admin_id_fkey" FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."support_sessions"
  ADD CONSTRAINT "support_sessions_target_id_fkey" FOREIGN KEY (target_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "better_supabase"."team_members"
  ADD CONSTRAINT "team_members_membership_fkey" FOREIGN KEY (tenant_id, user_id) REFERENCES public.organization_memberships(organization_id, user_id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."team_members"
  ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."team_members"
  ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY (team_id) REFERENCES better_supabase.teams(id) ON DELETE CASCADE;

ALTER TABLE "better_supabase"."user_settings"
  ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."quotes"
  ADD CONSTRAINT "quotes_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'approved'::text])));

CREATE VIEW "better_supabase"."maintenance_jobs" WITH (security_invoker=true) AS  SELECT j.job,
    j.fn AS function,
    j.every_interval AS every,
    s.last_run_at,
    s.last_status,
    s.last_error,
    COALESCE(s.runs, (0)::bigint) AS runs,
    ((s.last_run_at IS NULL) OR ((s.last_run_at + j.every_interval) <= now())) AS due
   FROM (( VALUES ('expire_approvals'::text,'"better_supabase"."expire_approvals"'::text,'00:15:00'::interval), ('expire_support_sessions'::text,'"better_supabase"."expire_support_sessions"'::text,'00:05:00'::interval), ('purge_usage_events'::text,'"better_supabase"."purge_usage_events"'::text,'1 day'::interval)) j(job, fn, every_interval)
     LEFT JOIN better_supabase.maintenance_state s ON ((s.job = j.job)));

CREATE VIEW "permdock"."permdock_ceiling" WITH (security_invoker=true) AS  SELECT scope,
    role,
    permission,
    grant_key,
    effect
   FROM permdock.role_permissions rp
  WHERE ((role = ANY (ARRAY['admin'::text, 'guest'::text, 'lead'::text, 'member'::text, 'owner'::text])) AND (EXISTS ( SELECT 1
           FROM permdock.role_permissions a
          WHERE ((a.role = rp.role) AND (a.permission = rp.permission) AND (a.scope = rp.scope) AND (a.effect = 'allow'::text)))));

CREATE VIEW "permdock"."permission_keys" WITH (security_invoker=true) AS  SELECT permission,
    scope,
    effect,
    grant_key,
    conditioned
   FROM ( VALUES ('quotes.list'::text,'customer'::text,'allow'::text,'quotes.list'::text,false), ('quotes.read'::text,'customer'::text,'allow'::text,'quotes.read'::text,false), ('access_requests.create'::text,'organization'::text,'allow'::text,'access_requests.create'::text,false), ('access_requests.emergency'::text,'organization'::text,'allow'::text,'access_requests.emergency'::text,false), ('access_requests.manage'::text,'organization'::text,'allow'::text,'access_requests.manage'::text,false), ('access_requests.read'::text,'organization'::text,'allow'::text,'access_requests.read'::text,false), ('access_requests.review'::text,'organization'::text,'allow'::text,'access_requests.review'::text,false), ('api_keys.manage'::text,'organization'::text,'allow'::text,'api_keys.manage'::text,false), ('api_keys.own'::text,'organization'::text,'allow'::text,'api_keys.own'::text,false), ('approvals.manage'::text,'organization'::text,'allow'::text,'approvals.manage'::text,false), ('approvals.read'::text,'organization'::text,'allow'::text,'approvals.read'::text,false), ('approvals.request'::text,'organization'::text,'allow'::text,'approvals.request'::text,false), ('audit.read'::text,'organization'::text,'allow'::text,'audit.read'::text,false), ('audit.revert'::text,'organization'::text,'allow'::text,'audit.revert'::text,false), ('automations.manage'::text,'organization'::text,'allow'::text,'automations.manage'::text,false), ('automations.publish'::text,'organization'::text,'allow'::text,'automations.publish'::text,false), ('automations.read'::text,'organization'::text,'allow'::text,'automations.read'::text,false), ('automations.write'::text,'organization'::text,'allow'::text,'automations.write'::text,false), ('billing.read'::text,'organization'::text,'allow'::text,'billing.read'::text,false), ('impersonation.read'::text,'organization'::text,'allow'::text,'impersonation.read'::text,false), ('impersonation.revoke'::text,'organization'::text,'allow'::text,'impersonation.revoke'::text,false), ('impersonation.start'::text,'organization'::text,'allow'::text,'impersonation.start'::text,false), ('members.invite'::text,'organization'::text,'allow'::text,'members.invite'::text,false), ('members.read'::text,'organization'::text,'allow'::text,'members.read'::text,false), ('members.remove'::text,'organization'::text,'allow'::text,'members.remove'::text,false), ('members.update_role'::text,'organization'::text,'allow'::text,'members.update_role'::text,false), ('organization.delete'::text,'organization'::text,'allow'::text,'organization.delete'::text,false), ('organization.transfer_ownership'::text,'organization'::text,'allow'::text,'organization.transfer_ownership'::text,false), ('organization.update'::text,'organization'::text,'allow'::text,'organization.update'::text,false), ('quotes.create'::text,'organization'::text,'allow'::text,'quotes.create'::text,false), ('quotes.delete'::text,'organization'::text,'allow'::text,'quotes.delete'::text,true), ('quotes.list'::text,'organization'::text,'allow'::text,'quotes.list'::text,false), ('quotes.read'::text,'organization'::text,'allow'::text,'quotes.read'::text,false), ('quotes.send'::text,'organization'::text,'allow'::text,'quotes.send'::text,true), ('quotes.update'::text,'organization'::text,'allow'::text,'quotes.update'::text,false), ('relations.manage'::text,'organization'::text,'allow'::text,'relations.manage'::text,false), ('relations.read'::text,'organization'::text,'allow'::text,'relations.read'::text,false), ('roles.manage'::text,'organization'::text,'allow'::text,'roles.manage'::text,false), ('service_accounts.manage'::text,'organization'::text,'allow'::text,'service_accounts.manage'::text,false), ('service_accounts.read'::text,'organization'::text,'allow'::text,'service_accounts.read'::text,false), ('settings.manage'::text,'organization'::text,'allow'::text,'settings.manage'::text,false), ('settings.read'::text,'organization'::text,'allow'::text,'settings.read'::text,false), ('settings.update'::text,'organization'::text,'allow'::text,'settings.update'::text,false), ('sso.manage'::text,'organization'::text,'allow'::text,'sso.manage'::text,false), ('staff.list'::text,'organization'::text,'allow'::text,'staff.list'::text,false), ('staff.read'::text,'organization'::text,'allow'::text,'staff.read'::text,false), ('teams.manage'::text,'organization'::text,'allow'::text,'teams.manage'::text,false), ('teams.read'::text,'organization'::text,'allow'::text,'teams.read'::text,false), ('usage.read'::text,'organization'::text,'allow'::text,'usage.read'::text,false), ('usage.record'::text,'organization'::text,'allow'::text,'usage.record'::text,false), ('teams.read'::text,'team'::text,'allow'::text,'teams.read'::text,false)) v(permission, scope, effect, grant_key, conditioned);

CREATE INDEX access_requests_approval_idx ON better_supabase.access_requests USING btree (approval_id)
  WHERE (approval_id IS NOT NULL);

CREATE INDEX access_requests_expiry_idx ON better_supabase.access_requests USING btree (expires_at)
  WHERE ((granted_at IS NOT NULL) AND (ended_at IS NULL));

CREATE INDEX access_requests_tenant_idx ON better_supabase.access_requests USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX api_keys_rotated_from_idx ON better_supabase.api_keys USING btree (rotated_from);

CREATE INDEX api_keys_tenant_idx ON better_supabase.api_keys USING btree (tenant_id);

CREATE INDEX api_keys_user_idx ON better_supabase.api_keys USING btree (user_id);

CREATE INDEX approval_decisions_delegate_idx ON better_supabase.approval_decisions USING btree (delegate_to)
  WHERE (delegate_to IS NOT NULL);

CREATE INDEX approval_items_tenant_idx ON better_supabase.approval_items USING btree (tenant_id, status);

CREATE UNIQUE INDEX approval_requests_pending_idx ON better_supabase.approval_requests USING btree (subject_type, subject_id, action)
  WHERE (status = 'pending'::text);

CREATE INDEX approval_requests_permdock_page ON better_supabase.approval_requests USING btree (((body ->> 'createdAt'::text)) COLLATE "C", token COLLATE "C");

CREATE INDEX approval_requests_permdock_status ON better_supabase.approval_requests USING btree (((body ->> 'status'::text)));

CREATE UNIQUE INDEX approval_requests_permdock_token ON better_supabase.approval_requests USING btree (token);

CREATE INDEX approval_requests_subject_idx ON better_supabase.approval_requests USING btree (subject_type, subject_id);

CREATE INDEX approval_requests_tenant_idx ON better_supabase.approval_requests USING btree (tenant_id, status, created_at DESC);

CREATE INDEX automation_evaluations_rule_idx ON better_supabase.automation_evaluations USING btree (rule_id, evaluated_at DESC);

CREATE INDEX automation_evaluations_tenant_idx ON better_supabase.automation_evaluations USING btree (tenant_id, evaluated_at DESC);

CREATE INDEX automation_versions_tenant_idx ON better_supabase.automation_versions USING btree (tenant_id);

CREATE UNIQUE INDEX automations_default_key_idx ON better_supabase.automations USING btree (tenant_id, default_key)
  WHERE (default_key IS NOT NULL);

CREATE INDEX automations_trigger_idx ON better_supabase.automations USING btree (tenant_id, subject_type, TRIGGER, rank);

CREATE UNIQUE INDEX bsb_teams_tenant_id_key ON better_supabase.teams USING btree (tenant_id, id);

ALTER TABLE "better_supabase"."team_members"
  ADD CONSTRAINT "team_members_team_tenant_fkey" FOREIGN KEY (tenant_id, team_id) REFERENCES better_supabase.teams(tenant_id, id) ON DELETE CASCADE;

CREATE INDEX invitations_accepted_by_idx ON better_supabase.invitations USING btree (accepted_by);

CREATE INDEX invitations_invited_by_idx ON better_supabase.invitations USING btree (invited_by);

CREATE UNIQUE INDEX invitations_open_email_idx ON better_supabase.invitations USING btree (tenant_id, lower(email))
  WHERE ((accepted_at IS NULL) AND (declined_at IS NULL) AND (revoked_at IS NULL));

CREATE INDEX invitations_tenant_created_idx ON better_supabase.invitations USING btree (tenant_id, created_at);

CREATE UNIQUE INDEX organization_payment_accounts_primary_idx ON better_supabase.organization_payment_accounts USING btree (tenant_id)
  WHERE is_primary;

CREATE INDEX organizations_created_by_idx ON better_supabase.organizations USING btree (created_by);

CREATE UNIQUE INDEX organizations_slug_idx ON better_supabase.organizations USING btree (lower(slug))
  WHERE (deleted_at IS NULL);

CREATE INDEX relations_source_idx ON better_supabase.relations USING btree (tenant_id, source_type, source_id, kind);

CREATE INDEX relations_target_idx ON better_supabase.relations USING btree (tenant_id, target_type, target_id, kind);

CREATE INDEX scim_group_members_member_idx ON better_supabase.scim_group_members USING btree (scim_user_id);

CREATE UNIQUE INDEX scim_groups_display_name_idx ON better_supabase.scim_groups USING btree (tenant_id, lower(display_name));

CREATE UNIQUE INDEX scim_groups_external_id_idx ON better_supabase.scim_groups USING btree (tenant_id, external_id)
  WHERE (external_id IS NOT NULL);

CREATE INDEX scim_users_account_idx ON better_supabase.scim_users USING btree (user_id)
  WHERE (user_id IS NOT NULL);

CREATE INDEX scim_users_email_idx ON better_supabase.scim_users USING btree (email)
  WHERE (user_id IS NULL);

CREATE UNIQUE INDEX scim_users_external_id_idx ON better_supabase.scim_users USING btree (tenant_id, external_id)
  WHERE (external_id IS NOT NULL);

CREATE UNIQUE INDEX scim_users_user_idx ON better_supabase.scim_users USING btree (tenant_id, user_id)
  WHERE (user_id IS NOT NULL);

CREATE UNIQUE INDEX scim_users_user_name_idx ON better_supabase.scim_users USING btree (tenant_id, lower(user_name));

CREATE INDEX service_principals_created_by_idx ON better_supabase.service_principals USING btree (created_by);

CREATE UNIQUE INDEX service_principals_default_idx ON better_supabase.service_principals USING btree (tenant_id)
  WHERE (is_default AND (disabled_at IS NULL));

CREATE INDEX service_principals_tenant_idx ON better_supabase.service_principals USING btree (tenant_id);

CREATE INDEX ssf_events_created_idx ON better_supabase.ssf_events USING btree (created_at);

CREATE INDEX ssf_events_order_idx ON better_supabase.ssf_events USING btree (stream_id, created_at);

CREATE INDEX ssf_received_at_idx ON better_supabase.ssf_received USING btree (received_at);

CREATE INDEX ssf_streams_endpoint_idx ON better_supabase.ssf_streams USING btree (endpoint_id)
  WHERE (endpoint_id IS NOT NULL);

CREATE INDEX ssf_streams_events_idx ON better_supabase.ssf_streams USING gin (events_delivered);

CREATE INDEX ssf_streams_receiver_idx ON better_supabase.ssf_streams USING btree (receiver);

CREATE UNIQUE INDEX sso_domains_verified_idx ON better_supabase.sso_domains USING btree (DOMAIN)
  WHERE (verified_at IS NOT NULL);

CREATE INDEX sso_providers_tenant_idx ON better_supabase.sso_providers USING btree (tenant_id);

CREATE INDEX support_requests_admin_idx ON better_supabase.support_requests USING btree (admin_id, target_id, requested_at DESC);

CREATE INDEX support_requests_approved_by_idx ON better_supabase.support_requests USING btree (approved_by);

CREATE INDEX support_requests_target_idx ON better_supabase.support_requests USING btree (target_id);

CREATE INDEX support_sessions_admin_idx ON better_supabase.support_sessions USING btree (admin_id, started_at DESC);

CREATE UNIQUE INDEX support_sessions_one_active_idx ON better_supabase.support_sessions USING btree (admin_id)
  WHERE (ended_at IS NULL);

CREATE INDEX support_sessions_target_idx ON better_supabase.support_sessions USING btree (target_id, started_at DESC);

CREATE INDEX team_members_membership_idx ON better_supabase.team_members USING btree (tenant_id, user_id);

CREATE INDEX team_members_tenant_team_idx ON better_supabase.team_members USING btree (tenant_id, team_id);

CREATE INDEX team_members_user_idx ON better_supabase.team_members USING btree (user_id);

CREATE INDEX usage_counters_unreported_idx ON better_supabase.usage_counters USING btree (day)
  WHERE (VALUE > reported_value);

CREATE INDEX usage_events_recorded_at_idx ON better_supabase.usage_events USING btree (recorded_at);

CREATE TRIGGER bsb_sso_auth_user
  AFTER INSERT OR UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.sso_on_auth_user();

CREATE CONSTRAINT TRIGGER bsb_audit
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.access_requests DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (((better_supabase.import_run() IS NULL) OR (current_setting('better_supabase.import_audit'::text, true) IS DISTINCT FROM 'summary'::text)))
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"access_request","event_prefix":"access_request"}');

CREATE CONSTRAINT TRIGGER bsb_audit
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.api_keys DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (((better_supabase.import_run() IS NULL) OR (current_setting('better_supabase.import_audit'::text, true) IS DISTINCT FROM 'summary'::text)))
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"api_key","event_prefix":"api_key"}');

CREATE CONSTRAINT TRIGGER bsb_audit
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.approval_requests DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (((better_supabase.import_run() IS NULL) OR (current_setting('better_supabase.import_audit'::text, true) IS DISTINCT FROM 'summary'::text)))
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"approval","event_prefix":"approval"}');

CREATE CONSTRAINT TRIGGER bsb_audit
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.automations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (((better_supabase.import_run() IS NULL) OR (current_setting('better_supabase.import_audit'::text, true) IS DISTINCT FROM 'summary'::text)))
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"automation","event_prefix":"automation"}');

CREATE TRIGGER bsb_updated_at
  BEFORE UPDATE ON better_supabase.invitations
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE TRIGGER bsb_record_organization_setting
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.organization_settings
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.record_organization_setting();

CREATE TRIGGER bsb_updated_at
  BEFORE UPDATE ON better_supabase.organizations
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE TRIGGER bsb_record_platform_setting
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.platform_settings
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.record_platform_setting();

CREATE CONSTRAINT TRIGGER bsb_audit
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.relations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (((better_supabase.import_run() IS NULL) OR (current_setting('better_supabase.import_audit'::text, true) IS DISTINCT FROM 'summary'::text)))
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"relation","event_prefix":"relation"}');

CREATE TRIGGER bsb_updated_at
  BEFORE UPDATE ON better_supabase.ssf_streams
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.set_updated_at('updated_at');

CREATE TRIGGER bsb_approval_memo
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.team_members
  FOR EACH STATEMENT
  EXECUTE FUNCTION better_supabase.approval_memo_bump();

CREATE CONSTRAINT TRIGGER bsb_audit
  AFTER INSERT OR DELETE OR UPDATE ON better_supabase.teams DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (((better_supabase.import_run() IS NULL) OR (current_setting('better_supabase.import_audit'::text, true) IS DISTINCT FROM 'summary'::text)))
  EXECUTE FUNCTION better_supabase.audit_row_change('{"ignore":[],"redact":[],"target_type":"team","event_prefix":"team"}');

CREATE TRIGGER bsb_approval_memo
  AFTER INSERT OR DELETE OR UPDATE ON public.organization_memberships
  FOR EACH STATEMENT
  EXECUTE FUNCTION better_supabase.approval_memo_bump();

CREATE CONSTRAINT TRIGGER bsb_organization_owner
  AFTER DELETE OR UPDATE OF ROLE, organization_id ON public.organization_memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.ensure_organization_owner();

CREATE TRIGGER bsb_organization_role_guard
  BEFORE INSERT OR UPDATE ON public.organization_memberships
  FOR EACH ROW
  EXECUTE FUNCTION better_supabase.guard_membership();

CREATE POLICY "bsb_access_requests_read" ON "better_supabase"."access_requests"
  FOR SELECT
  TO "authenticated"
  USING (((tenant_id IN ( SELECT better_supabase.tenant_ids_with('access_requests.read'::text) AS tenant_ids_with)) OR (user_id = ( SELECT auth.uid() AS uid))));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."access_requests"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."access_requests"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."access_requests"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR ((tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('access_requests.read'::text) AS tenant_ids_with)) OR (user_id = ( SELECT auth.uid() AS uid)))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."access_requests"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_approval_decisions_read" ON "better_supabase"."approval_decisions"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.tenant_ids_with('approvals.read'::text) AS tenant_ids_with)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."approval_decisions"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."approval_decisions"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."approval_decisions"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('approvals.read'::text) AS tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."approval_decisions"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_approval_items_read" ON "better_supabase"."approval_items"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.tenant_ids_with('approvals.read'::text) AS tenant_ids_with)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."approval_items"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."approval_items"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."approval_items"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('approvals.read'::text) AS tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."approval_items"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_approval_requests_read" ON "better_supabase"."approval_requests"
  FOR SELECT
  TO "authenticated"
  USING
    ((((tenant_id IN ( SELECT better_supabase.tenant_ids_with('approvals.read'::text) AS tenant_ids_with)) AND (NOT (subject_type = 'support_request'::text))) OR (requested_by = (
    SELECT auth.uid() AS uid))));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."approval_requests"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."approval_requests"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."approval_requests"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (((tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('approvals.read'::text) AS tenant_ids_with)) AND (NOT (subject_type = 'support_request'::text))) OR
    (requested_by = ( SELECT auth.uid() AS uid)))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."approval_requests"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_invitations_read" ON "better_supabase"."invitations"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.invitation_tenant_ids() AS invitation_tenant_ids)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."invitations"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."invitations"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."invitations"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT better_supabase.invitation_tenant_ids() AS
    invitation_tenant_ids))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."invitations"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_organization_payment_accounts_read" ON "better_supabase"."organization_payment_accounts"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_organization_profiles_read" ON "better_supabase"."organization_profiles"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_organization_settings_delete" ON "better_supabase"."organization_settings"
  FOR DELETE
  TO "authenticated"
  USING
    (((tenant_id IN ( SELECT better_supabase.tenant_ids_with('settings.update'::text) AS tenant_ids_with)) AND ( SELECT permdock.permdock_actor_may_write() AS
    permdock_actor_may_write)));

CREATE POLICY "bsb_organization_settings_insert" ON "better_supabase"."organization_settings"
  FOR INSERT
  TO "authenticated"
  WITH
    CHECK
    (((tenant_id IN ( SELECT better_supabase.tenant_ids_with('settings.update'::text) AS tenant_ids_with)) AND ( SELECT permdock.permdock_actor_may_write() AS
    permdock_actor_may_write)));

CREATE POLICY "bsb_organization_settings_read" ON "better_supabase"."organization_settings"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.tenant_ids_with('settings.read'::text) AS tenant_ids_with)));

CREATE POLICY "bsb_organization_settings_update" ON "better_supabase"."organization_settings"
  FOR UPDATE
  TO "authenticated"
  USING
    (((tenant_id IN ( SELECT better_supabase.tenant_ids_with('settings.update'::text) AS tenant_ids_with)) AND ( SELECT permdock.permdock_actor_may_write() AS
    permdock_actor_may_write)))
  WITH
    CHECK
    (((tenant_id IN ( SELECT better_supabase.tenant_ids_with('settings.update'::text) AS tenant_ids_with)) AND ( SELECT permdock.permdock_actor_may_write() AS
    permdock_actor_may_write)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."organization_settings"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('settings.update'::text) AS tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."organization_settings"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH
    CHECK
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('settings.update'::text) AS tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."organization_settings"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT better_supabase.tenant_ids_with('settings.read'::text)
    AS tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."organization_settings"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('settings.update'::text) AS tenant_ids_with))))
  WITH
    CHECK
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('settings.update'::text) AS tenant_ids_with))));

CREATE POLICY "bsb_organizations_read" ON "better_supabase"."organizations"
  FOR SELECT
  TO "authenticated"
  USING ((id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_platform_settings_delete" ON "better_supabase"."platform_settings"
  FOR DELETE
  TO "authenticated"
  USING
    ((( SELECT COALESCE(better_supabase.is_platform('settings.manage'::text), false) AS "coalesce") AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)));

CREATE POLICY "bsb_platform_settings_insert" ON "better_supabase"."platform_settings"
  FOR INSERT
  TO "authenticated"
  WITH
    CHECK
    ((( SELECT COALESCE(better_supabase.is_platform('settings.manage'::text), false) AS "coalesce") AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)));

CREATE POLICY "bsb_platform_settings_read_public" ON "better_supabase"."platform_settings"
  FOR SELECT
  TO "anon"
  USING (false);

CREATE POLICY "bsb_platform_settings_read" ON "better_supabase"."platform_settings"
  FOR SELECT
  TO "authenticated"
  USING (true);

CREATE POLICY "bsb_platform_settings_update" ON "better_supabase"."platform_settings"
  FOR UPDATE
  TO "authenticated"
  USING
    ((( SELECT COALESCE(better_supabase.is_platform('settings.manage'::text), false) AS "coalesce") AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)))
  WITH
    CHECK
    ((( SELECT COALESCE(better_supabase.is_platform('settings.manage'::text), false) AS "coalesce") AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)));

CREATE POLICY "bsb_relations_read" ON "better_supabase"."relations"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.tenant_ids_with('relations.read'::text) AS tenant_ids_with)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."relations"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."relations"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."relations"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('relations.read'::text) AS tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."relations"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_service_principals_read" ON "better_supabase"."service_principals"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.tenant_ids_with('service_accounts.read'::text) AS tenant_ids_with)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."service_principals"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."service_principals"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."service_principals"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('service_accounts.read'::text) AS tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."service_principals"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_support_requests_read" ON "better_supabase"."support_requests"
  FOR SELECT
  TO "authenticated"
  USING (((admin_id = ( SELECT auth.uid() AS uid)) OR ( SELECT better_supabase.is_platform('impersonation.read'::text) AS is_platform)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."support_requests"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."support_requests"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."support_requests"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR ((admin_id = ( SELECT auth.uid() AS uid)) OR ( SELECT
    better_supabase.is_platform('impersonation.read'::text) AS is_platform))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."support_requests"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_support_read" ON "better_supabase"."support_sessions"
  FOR SELECT
  TO "authenticated"
  USING (( SELECT better_supabase.is_platform('impersonation.read'::text) AS is_platform));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."support_sessions"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."support_sessions"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."support_sessions"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR ( SELECT better_supabase.is_platform('impersonation.read'::text) AS
    is_platform)));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."support_sessions"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_team_members_read" ON "better_supabase"."team_members"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.tenant_ids_with('teams.read'::text) AS tenant_ids_with)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."team_members"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."team_members"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."team_members"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT better_supabase.tenant_ids_with('teams.read'::text) AS
    tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."team_members"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_teams_read" ON "better_supabase"."teams"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.tenant_ids_with('teams.read'::text) AS tenant_ids_with)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."teams"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."teams"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."teams"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT better_supabase.tenant_ids_with('teams.read'::text) AS
    tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."teams"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."usage_counters"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."usage_counters"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."usage_counters"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR (tenant_id IN ( SELECT better_supabase.tenant_ids_with('usage.read'::text) AS
    tenant_ids_with))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."usage_counters"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_usage_counters_read" ON "better_supabase"."usage_counters"
  FOR SELECT
  TO "authenticated"
  USING ((tenant_id IN ( SELECT better_supabase.tenant_ids_with('usage.read'::text) AS tenant_ids_with)));

CREATE POLICY "bsb_tenant_scope_delete" ON "better_supabase"."usage_quotas"
  AS RESTRICTIVE
  FOR DELETE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_insert" ON "better_supabase"."usage_quotas"
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_tenant_scope_select" ON "better_supabase"."usage_quotas"
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING
    (((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)) OR ((tenant_id IS NULL) OR (tenant_id IN ( SELECT
    better_supabase.tenant_ids_with('usage.read'::text) AS tenant_ids_with)))));

CREATE POLICY "bsb_tenant_scope_update" ON "better_supabase"."usage_quotas"
  AS RESTRICTIVE
  FOR UPDATE
  TO PUBLIC
  USING ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)))
  WITH CHECK ((tenant_id IN ( SELECT better_supabase.member_organization_ids() AS member_organization_ids)));

CREATE POLICY "bsb_usage_quotas_read" ON "better_supabase"."usage_quotas"
  FOR SELECT
  TO "authenticated"
  USING (((tenant_id IS NULL) OR (tenant_id IN ( SELECT better_supabase.tenant_ids_with('usage.read'::text) AS tenant_ids_with))));

CREATE POLICY "bsb_user_settings_own_delete" ON "better_supabase"."user_settings"
  FOR DELETE
  TO "authenticated"
  USING (((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)));

CREATE POLICY "bsb_user_settings_own_insert" ON "better_supabase"."user_settings"
  FOR INSERT
  TO "authenticated"
  WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)));

CREATE POLICY "bsb_user_settings_own_read" ON "better_supabase"."user_settings"
  FOR SELECT
  TO "authenticated"
  USING ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "bsb_user_settings_own_update" ON "better_supabase"."user_settings"
  FOR UPDATE
  TO "authenticated"
  USING (((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)))
  WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write)));

CREATE POLICY "quotes_delete_read_only_actors" ON "public"."quotes"
  AS RESTRICTIVE
  FOR DELETE
  TO "authenticated"
  USING (( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write));

CREATE POLICY "quotes_delete" ON "public"."quotes"
  FOR DELETE
  TO "authenticated"
  USING (((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.delete'::text) AS permitted_organization_ids))) AND (status = 'draft'::text)));

CREATE POLICY "quotes_insert_read_only_actors" ON "public"."quotes"
  AS RESTRICTIVE
  FOR INSERT
  TO "authenticated"
  WITH CHECK (( SELECT permdock.permdock_actor_may_write() AS permdock_actor_may_write));

CREATE POLICY "quotes_insert" ON "public"."quotes"
  FOR INSERT
  TO "authenticated"
  WITH CHECK ((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.create'::text) AS permitted_organization_ids))));

CREATE POLICY "quotes_select" ON "public"."quotes"
  FOR SELECT
  TO "authenticated"
  USING
    (((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.read'::text) AS permitted_organization_ids))) OR (customer_id = ANY (ARRAY( SELECT
    permdock.permitted_customer_ids('quotes.read'::text) AS permitted_customer_ids))) OR
    ((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.list'::text) AS permitted_organization_ids))) OR (customer_id = ANY (ARRAY( SELECT
    permdock.permitted_customer_ids('quotes.list'::text) AS permitted_customer_ids)))) OR
    (( SELECT permdock.permdock_api_key_allows('quotes.list'::text) AS permdock_api_key_allows) AND (customer_id = ANY (ARRAY( SELECT permdock.member_customer_ids() AS
    member_customer_ids))))));

CREATE POLICY "quotes_update" ON "public"."quotes"
  FOR UPDATE
  TO "authenticated"
  USING
    (((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.update'::text) AS permitted_organization_ids))) OR ((organization_id = ANY (ARRAY( SELECT
    permdock.permitted_organization_ids('quotes.send'::text) AS permitted_organization_ids))) AND (status = 'draft'::text))))
  WITH
    CHECK
    (((organization_id = ANY (ARRAY( SELECT permdock.permitted_organization_ids('quotes.update'::text) AS permitted_organization_ids))) OR ((organization_id = ANY (ARRAY( SELECT
    permdock.permitted_organization_ids('quotes.send'::text) AS permitted_organization_ids))) AND (status = 'draft'::text))));

COMMENT ON COLUMN "better_supabase"."approval_requests"."token" IS '@bsb identifier: the approval token is a SHA-256 digest of the decision inputs, which the approval is bound to, not a secret';

REVOKE ALL ON FUNCTION "better_supabase"."accept_invitation"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."accept_invitation"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."accept_invitation_by_id"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."accept_invitation_by_id"(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."accepting_invitation"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."accepting_invitation"() TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."active_support_session"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."active_support_session"(uuid, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."add_organization_domain"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."add_organization_domain"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."add_team_member"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."add_team_member"(uuid, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."ancestors"(uuid, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."ancestors"(uuid, text, text, text) TO "authenticated", "service_role";

GRANT EXECUTE ON FUNCTION "better_supabase"."api_key_tenant"() TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."apply_support_approval"(uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."approval_effective_policy"(uuid, text, text, jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."approval_eligible"(better_supabase.approval_requests) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."approval_eligible"(better_supabase.approval_requests) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."approval_eligible"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."approval_eligible"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."approval_eligible_ids"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."approval_eligible_ids"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."approval_fact"(uuid, text, text, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."approval_finalize"(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."approval_memo_bump"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."approval_notify"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."approval_policy"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."approval_policy"(text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."approval_policy_tighten"(jsonb, jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."approval_requirement"(uuid, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."approval_requirement"(uuid, text, text, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."approval_settle"(text, text, text, text, uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."approve_support_request"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."approve_support_request"(uuid, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."approved_support_request"(uuid, uuid, boolean, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."approved_support_request"(uuid, uuid, boolean, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."archive_team"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."archive_team"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."caller_authz_version"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."caller_authz_version"() TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."cancel_approval"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."cancel_approval"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."check_sso_provider"(uuid, text[], uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."check_sso_provider"(uuid, text[], uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."close_support_request"(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."consume_approval"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."consume_approval"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."consume_quota"(uuid, text, numeric, text, text, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."consume_quota"(uuid, text, numeric, text, text, jsonb, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."converted_into"(uuid, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."converted_into"(uuid, text, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."create_api_key"(text, text, text, uuid, boolean, text[], timestamp WITH time zone, integer, text, text) FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION "better_supabase"."create_api_key"(text, text, text, uuid, boolean, text[], timestamp WITH time zone, integer, text, text)
  TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."create_invitation"(uuid, text, text, interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."create_invitation"(uuid, text, text, interval) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."create_organization"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."create_organization"(jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."create_ssf_stream"(uuid, text, text, text[], text, text[], text[], text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."create_ssf_stream"(uuid, text, text, text[], text, text[], text[], text, text, jsonb) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."create_team"(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."create_team"(uuid, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."decide_approval"(uuid, text, text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."decide_approval"(uuid, text, text, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."decide_approval_items"(uuid, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."decide_approval_items"(uuid, jsonb, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."decline_invitation"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."decline_invitation"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."decline_invitation_by_id"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."decline_invitation_by_id"(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."default_service_principal"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."default_service_principal"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."delegate_approval"(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."delegate_approval"(uuid, uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."delete_organization"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."delete_organization"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."delete_ssf_stream"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."delete_ssf_stream"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."descendants"(uuid, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."descendants"(uuid, text, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."disable_service_principal"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."disable_service_principal"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."end_access"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."end_access"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."end_my_session"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."end_my_session"(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."end_sessions"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."end_sessions"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."end_support_session"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."end_support_session"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."ensure_organization_owner"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."entitlement_members"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."entitlement_members"(text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."entitlement_value"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."entitlement_value"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."escalate_approvals"(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."escalate_approvals"(integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."expire_access_grants"(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."expire_access_grants"(integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."expire_approvals"(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."expire_approvals"(integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."expire_support_sessions"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."expire_support_sessions"() TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."feature_claims"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."feature_claims"(uuid) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."forget_ssf_received"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."forget_ssf_received"(text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."get_access_request"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_access_request"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."get_approval"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_approval"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."get_approvals"(uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_approvals"(uuid[]) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."get_organization_settings"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_organization_settings"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."get_platform_settings"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_platform_settings"() TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."get_support_session"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_support_session"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."get_team"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_team"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."get_user_settings"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."get_user_settings"() TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."grant_access_request"(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."guard_membership"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."guard_membership_role"(uuid, uuid, text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."guard_membership_role"(uuid, uuid, text, uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."has_entitlement"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."has_entitlement"(uuid, text) TO "authenticated", "service_role";

GRANT EXECUTE ON FUNCTION "better_supabase"."has_scope"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."import_organization_profile"(uuid, jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."import_organization_profile"(uuid, jsonb, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."install_default_rules"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."install_default_rules"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."invitation_extra"(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."invitation_preview"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."invitation_preview"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."invitation_tenant_ids"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."invitation_tenant_ids"() TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."invite_member"(uuid, text, text, interval, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."invite_member"(uuid, text, text, interval, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."invite_within_seats"(uuid, text, text, interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."invite_within_seats"(uuid, text, text, interval) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."is_approved"(text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."is_approved"(text, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."last_sign_ins"(uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."last_sign_ins"(uuid[]) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."leave_organization"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."leave_organization"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."link"(uuid, text, text, text, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."link"(uuid, text, text, text, text, text, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_access_requests"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_access_requests"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_api_keys"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_api_keys"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_approvals"(uuid, text, boolean, text, text, integer, timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_approvals"(uuid, text, boolean, text, text, integer, timestamp WITH time zone) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_members"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_members"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_my_organizations"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_my_organizations"() TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_my_sessions"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_my_sessions"() TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."list_organization_domains"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_organization_domains"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_organization_invitations"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_organization_invitations"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_sso_providers"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_sso_providers"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_support_sessions"(uuid, uuid, boolean, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_support_sessions"(uuid, uuid, boolean, integer) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."list_teams"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."list_teams"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."maintenance"(text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."maintenance"(text, boolean) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."maintenance_schedule"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."maintenance_schedule"(text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."maintenance_scheduler"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."maintenance_scheduler"() TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."mark_usage_reported"(uuid, text, date, numeric) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."mark_usage_reported"(uuid, text, date, numeric) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."mark_used"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."mark_used"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."matching_rules"(uuid, text, text, jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."matching_rules"(uuid, text, text, jsonb, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."my_invitations"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."my_invitations"() TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."note_ssf_verification"(uuid, interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."note_ssf_verification"(uuid, interval) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."open_approval"(uuid, text, text, text, jsonb, text, jsonb, uuid, boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."organization_domain"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."organization_domain"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."organization_overview"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."organization_overview"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."organization_profile_updated_at"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."organization_profile_updated_at"(text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."organization_setting"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."organization_setting"(uuid, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."organization_slug_problem"(text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."organization_slug_problem"(text, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."page_api_keys"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."page_api_keys"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."page_approvals"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."page_approvals"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."page_organization_domains"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."page_organization_domains"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."page_organization_invitations"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."page_organization_invitations"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."page_organization_members"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."page_organization_members"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."page_service_principals"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."page_service_principals"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."page_sso_providers"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."page_sso_providers"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."page_support_sessions"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."page_support_sessions"(jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."poll_ssf_events"(uuid, integer, text[], jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."poll_ssf_events"(uuid, integer, text[], jsonb) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."purge_shared_signals"(interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."purge_shared_signals"(interval) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."purge_team"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."purge_team"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."purge_teams"(uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."purge_teams"(uuid[]) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."purge_usage_events"(interval, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."purge_usage_events"(interval, integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."purge_usage_history"(interval, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."purge_usage_history"(interval, integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."queue_ssf_set"(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."queue_ssf_set"(uuid, text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rank_rule"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rank_rule"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."record_approval_created"(uuid, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."record_approval_created"(uuid, text, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."record_organization_setting"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."record_platform_setting"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."record_rule_evaluation"(uuid, text, boolean, jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."record_rule_evaluation"(uuid, text, boolean, jsonb, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."record_ssf_received"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."record_ssf_received"(text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."record_usage"(uuid, text, numeric, text, text, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."record_usage"(uuid, text, numeric, text, text, jsonb, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."record_usage_batch"(uuid, jsonb, text, boolean, text, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."record_usage_batch"(uuid, jsonb, text, boolean, text, jsonb, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."register_service_principal"(uuid, uuid, text, text, boolean, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."register_service_principal"(uuid, uuid, text, text, boolean, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."register_sso_provider"(uuid, uuid, text[], text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."register_sso_provider"(uuid, uuid, text[], text, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."relation_rollup"(uuid, text, text, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."relation_rollup"(uuid, text, text, text, text, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."relation_walk"(uuid, text, text, text, boolean, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."relation_walk"(uuid, text, text, text, boolean, integer) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."relations_by_kind"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."relations_by_kind"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."relations_of"(uuid, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."relations_of"(uuid, text, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."remind_approvals"(interval, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."remind_approvals"(interval, integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."remove_member"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."remove_member"(uuid, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."remove_organization_domain"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."remove_organization_domain"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."remove_rule"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."remove_rule"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."remove_team_member"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."remove_team_member"(uuid, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."remove_usage_quota"(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."remove_usage_quota"(uuid, text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."request_access"(uuid, text, text, interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."request_access"(uuid, text, text, interval) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."request_approval"(uuid, text, text, text, text, jsonb, text, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."request_approval"(uuid, text, text, text, text, jsonb, text, jsonb, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."request_approval_items"(uuid, text, text, text, jsonb, text, jsonb, text, jsonb, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."request_approval_items"(uuid, text, text, text, jsonb, text, jsonb, text, jsonb, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."request_support_session"(uuid, text, boolean, jsonb, uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."request_support_session"(uuid, text, boolean, jsonb, uuid, uuid, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."resend_invitation"(uuid, interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."resend_invitation"(uuid, interval) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."resend_invitations"(uuid[], interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."resend_invitations"(uuid[], interval) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."reset_default_rule"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."reset_default_rule"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."reset_organization_setting"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."reset_organization_setting"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."reset_platform_setting"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."reset_platform_setting"(text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."reset_user_setting"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."reset_user_setting"(text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."revoke_api_key"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."revoke_api_key"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."revoke_invitation"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."revoke_invitation"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rotate_api_key"(uuid, text, text, interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rotate_api_key"(uuid, text, text, interval) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_boolean"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_boolean"(jsonb) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_bounds"(text, jsonb, text, timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_bounds"(text, jsonb, text, timestamp WITH time zone) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_check"(jsonb, jsonb, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_check"(jsonb, jsonb, integer) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_date"(text, text, jsonb, jsonb, text, timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_date"(text, text, jsonb, jsonb, text, timestamp WITH time zone) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_equal"(text, jsonb, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_equal"(text, jsonb, jsonb) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_evaluate"(jsonb, jsonb, jsonb, text, timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_evaluate"(jsonb, jsonb, jsonb, text, timestamp WITH time zone) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_evaluations_list"(uuid, timestamp WITH time zone, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_evaluations_list"(uuid, timestamp WITH time zone, integer) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_field_map"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_field_map"(text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_fields_list"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_fields_list"(text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_get"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_get"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_list"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_list"(jsonb) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_matches"(jsonb, jsonb, jsonb, text, timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_matches"(jsonb, jsonb, jsonb, text, timestamp WITH time zone) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_moment"(text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_moment"(text, jsonb) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_node"(jsonb, jsonb, jsonb, text, timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_node"(jsonb, jsonb, jsonb, text, timestamp WITH time zone) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_numeric"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_numeric"(jsonb) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_positive"(text, text, text, jsonb, jsonb, text, timestamp WITH time zone) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_positive"(text, text, text, jsonb, jsonb, text, timestamp WITH time zone) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_text"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_text"(jsonb) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rule_versions_list"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rule_versions_list"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."rules_list"(uuid, text, text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."rules_list"(uuid, text, text, boolean) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."run_rules"(uuid, text, text, text, jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."run_rules"(uuid, text, text, text, jsonb, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."save_rule"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."save_rule"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_delete_group"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_delete_group"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_delete_user"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_delete_user"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_get_group"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_get_group"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_get_user"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_get_user"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_group_role"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_group_role"(text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_list_groups"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_list_groups"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_list_users"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_list_users"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_save_group"(uuid, uuid, jsonb, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_save_group"(uuid, uuid, jsonb, integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_save_user"(uuid, uuid, jsonb, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_save_user"(uuid, uuid, jsonb, integer) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."scim_sync_member"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."scim_sync_member"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."seed_tenant_defaults"(uuid, jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."seed_tenant_defaults"(uuid, jsonb, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."service_principals_list"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."service_principals_list"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."session_active"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."session_active"() TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."session_end_reason"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."session_end_reason"() TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."sessions_overview"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."sessions_overview"() TO "authenticated";

REVOKE ALL ON FUNCTION "better_supabase"."set_organization_setting"(uuid, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."set_organization_setting"(uuid, text, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."set_platform_setting"(text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."set_platform_setting"(text, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."set_rule_enabled"(uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."set_rule_enabled"(uuid, boolean) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."set_service_principal_role"(uuid, text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."set_service_principal_role"(uuid, text, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."set_ssf_stream_status"(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."set_ssf_stream_status"(uuid, text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."set_usage_quota"(uuid, text, text, numeric, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."set_usage_quota"(uuid, text, text, numeric, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."set_user_setting"(text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."set_user_setting"(text, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."settle_approval"(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."settle_approval"(uuid, text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."sole_owned_organizations"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."sole_owned_organizations"(uuid, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."ssf_stream"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."ssf_stream"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."ssf_streams"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."ssf_streams"(text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."ssf_streams_for_event"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."ssf_streams_for_event"(text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."sso_access_token_check"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."sso_access_token_check"(jsonb) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."sso_domain_for"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."sso_domain_for"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."sso_on_auth_user"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."sso_provider"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."sso_provider"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."start_support_session"(uuid, text, interval, boolean, jsonb, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."start_support_session"(uuid, text, interval, boolean, jsonb, uuid, uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."stripe_customer_tenants"(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."support_request"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."support_request"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."support_request_approvable"(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."support_target_claims"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."support_target_claims"(uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."switch_organization"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."switch_organization"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."sync_rule_fields"(text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."sync_rule_fields"(text, jsonb) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."team_ids_of"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."team_ids_of"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."tenant_entitlement_value"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."tenant_entitlement_value"(uuid, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."tenant_entitlements"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."tenant_entitlements"(uuid) TO "service_role", "supabase_auth_admin";

REVOKE ALL ON FUNCTION "better_supabase"."tenant_ids_with_entitlement"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."tenant_ids_with_entitlement"(text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."tenant_stripe_customer"(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "better_supabase"."transfer_ownership"(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."transfer_ownership"(uuid, uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."unlink"(uuid, text, text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."unlink"(uuid, text, text, text, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."unregister_sso_provider"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."unregister_sso_provider"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."unreported_usage"(integer, text[], uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."unreported_usage"(integer, text[], uuid[]) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."update_invitation"(uuid, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."update_invitation"(uuid, text, text, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."update_member_role"(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."update_member_role"(uuid, uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."update_member_roles"(uuid, uuid[], text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."update_member_roles"(uuid, uuid[], text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."update_organization"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."update_organization"(uuid, jsonb) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."update_organization_domain"(uuid, text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."update_organization_domain"(uuid, text, boolean) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."update_ssf_stream"(uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."update_ssf_stream"(uuid, jsonb) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."update_team"(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."update_team"(uuid, text, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_breakdown"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_breakdown"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_history"(uuid, text, integer, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_history"(uuid, text, integer, bigint) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_meters"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_meters"() TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_overview"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_overview"(uuid) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_quota"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_quota"(uuid, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_quotas_for"(uuid[], text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_quotas_for"(uuid[], text[]) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_remaining"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_remaining"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_status"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_status"(uuid, text) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_used"(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_used"(uuid, text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_window"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_window"(uuid, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."usage_window_start"(uuid, text, date) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."usage_window_start"(uuid, text, date) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."verify_api_key"(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."verify_api_key"(text, text) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."verify_organization_domain"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."verify_organization_domain"(uuid, uuid) TO "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."within_quota"(uuid, text, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."within_quota"(uuid, text, bigint) TO "authenticated", "service_role";

REVOKE ALL ON FUNCTION "permdock"."member_team_ids"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."member_team_ids"() TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permdock_api_key_allows"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permdock_api_key_allows"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_team_id_array"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_team_id_array"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_team_ids"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_team_ids"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_team_ids_by_permission"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_team_ids_by_permission"(text) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_team_ids_by_permission"(text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_team_ids_by_permission"(text, boolean) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_team_ids_by_permission_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_team_ids_by_permission_for"(uuid, text, boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_team_ids_for"(uuid, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_team_permission_keys"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_team_permission_keys"(uuid) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_team_permission_keys"(uuid, text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "permdock"."permitted_team_permission_keys"(uuid, text[]) TO "authenticated";

REVOKE ALL ON FUNCTION "permdock"."permitted_team_permission_keys_for"(uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION "permdock"."permitted_team_permission_keys_for"(uuid, uuid, text[]) FROM PUBLIC;

GRANT SELECT ON TABLE "better_supabase"."access_requests" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."access_requests" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."api_keys" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."approval_decisions" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."approval_decisions" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."approval_items" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."approval_items" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."approval_requests" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."approval_requests" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."automation_defaults" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."automation_evaluations" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."automation_fields" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."automation_versions" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."automations" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."invitations" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."invitations" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."maintenance_state" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."organization_payment_accounts" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."organization_payment_accounts" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."organization_profiles" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."organization_profiles" TO "service_role";

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE "better_supabase"."organization_settings" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."organization_settings" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."organizations" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."organizations" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."platform_settings" TO "anon";

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE "better_supabase"."platform_settings" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."platform_settings" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."relations" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."relations" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."scim_group_members" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."scim_groups" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."scim_users" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."service_principals" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."service_principals" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."ssf_events" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."ssf_received" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."ssf_streams" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."sso_domains" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."sso_providers" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."support_requests" TO "authenticated", "service_role";

GRANT SELECT ON TABLE "better_supabase"."support_sessions" TO "authenticated", "service_role";

GRANT SELECT ON TABLE "better_supabase"."team_members" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."team_members" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."teams" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."teams" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."usage_counters" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."usage_counters" TO "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."usage_events" TO "service_role";

GRANT SELECT ON TABLE "better_supabase"."usage_quotas" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."usage_quotas" TO "service_role";

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE "better_supabase"."user_settings" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "better_supabase"."user_settings" TO "service_role";

REVOKE ALL ON TABLE "public"."quotes" FROM "authenticated";

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE "public"."quotes" TO "authenticated";

GRANT SELECT ON TABLE "better_supabase"."maintenance_jobs" TO "service_role";

GRANT SELECT ON TABLE "permdock"."permission_keys" TO "authenticated";

ALTER TABLE "better_supabase"."api_keys"
  ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX api_keys_created_by_idx ON better_supabase.api_keys USING btree (created_by);

ALTER TABLE "better_supabase"."automations"
  ADD CONSTRAINT "automations_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX automations_created_by_idx ON better_supabase.automations USING btree (created_by)
  WHERE (created_by IS NOT NULL);

ALTER TABLE "better_supabase"."automations"
  ADD CONSTRAINT "automations_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX automations_updated_by_idx ON better_supabase.automations USING btree (updated_by)
  WHERE (updated_by IS NOT NULL);

ALTER TABLE "better_supabase"."organization_settings"
  ADD CONSTRAINT "organization_settings_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX organization_settings_updated_by_idx ON better_supabase.organization_settings USING btree (updated_by);

ALTER TABLE "better_supabase"."platform_settings"
  ADD CONSTRAINT "platform_settings_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX platform_settings_updated_by_idx ON better_supabase.platform_settings USING btree (updated_by);

ALTER TABLE "better_supabase"."sso_domains"
  ADD CONSTRAINT "sso_domains_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX sso_domains_created_by_idx ON better_supabase.sso_domains USING btree (created_by)
  WHERE (created_by IS NOT NULL);

ALTER TABLE "better_supabase"."user_settings"
  ADD CONSTRAINT "user_settings_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX user_settings_updated_by_idx ON better_supabase.user_settings USING btree (updated_by);
