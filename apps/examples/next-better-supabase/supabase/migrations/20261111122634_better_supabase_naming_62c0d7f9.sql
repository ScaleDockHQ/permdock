-- better-supabase codemod naming: renames installed objects, no data moves.
-- destructive: reviewed
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'agent_installs' and column_name = 'organization_id') then
    alter table "better_supabase"."agent_installs" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'agents' and column_name = 'organization_id') then
    alter table "better_supabase"."agents" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_batch_items' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_batch_items" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_batches' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_batches" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_cache_entries' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_cache_entries" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_chats' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_chats" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_documents' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_documents" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_files' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_files" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_moderation_events' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_moderation_events" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_projects' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_projects" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_provider_keys' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_provider_keys" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_sandboxes' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_sandboxes" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_scheduled_tasks' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_scheduled_tasks" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_task_runs' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_task_runs" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'ai_tool_policies' and column_name = 'organization_id') then
    alter table "better_supabase"."ai_tool_policies" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'api_keys' and column_name = 'organization_id') then
    alter table "better_supabase"."api_keys" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'attachment_document_types' and column_name = 'organization_id') then
    alter table "better_supabase"."attachment_document_types" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'attachment_versions' and column_name = 'organization_id') then
    alter table "better_supabase"."attachment_versions" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'attachments' and column_name = 'organization_id') then
    alter table "better_supabase"."attachments" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'audit_events' and column_name = 'organization_id') then
    alter table "better_supabase"."audit_events" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'automation_evaluations' and column_name = 'organization_id') then
    alter table "better_supabase"."automation_evaluations" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'automation_versions' and column_name = 'organization_id') then
    alter table "better_supabase"."automation_versions" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'automations' and column_name = 'organization_id') then
    alter table "better_supabase"."automations" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'billing_customers' and column_name = 'organization_id') then
    alter table "better_supabase"."billing_customers" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'billing_native_subscriptions' and column_name = 'organization_id') then
    alter table "better_supabase"."billing_native_subscriptions" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'comment_tasks' and column_name = 'organization_id') then
    alter table "better_supabase"."comment_tasks" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'connector_grants' and column_name = 'organization_id') then
    alter table "better_supabase"."connector_grants" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'connector_servers' and column_name = 'organization_id') then
    alter table "better_supabase"."connector_servers" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'data_exports' and column_name = 'organization_id') then
    alter table "better_supabase"."data_exports" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'data_subject_requests' and column_name = 'organization_id') then
    alter table "better_supabase"."data_subject_requests" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'eval_datasets' and column_name = 'organization_id') then
    alter table "better_supabase"."eval_datasets" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'eval_runs' and column_name = 'organization_id') then
    alter table "better_supabase"."eval_runs" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'flag_overrides' and column_name = 'organization_id') then
    alter table "better_supabase"."flag_overrides" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'guardrail_decisions' and column_name = 'organization_id') then
    alter table "better_supabase"."guardrail_decisions" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'guardrail_policies' and column_name = 'organization_id') then
    alter table "better_supabase"."guardrail_policies" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'hostnames' and column_name = 'organization_id') then
    alter table "better_supabase"."hostnames" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'invitations' and column_name = 'organization_id') then
    alter table "better_supabase"."invitations" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'invite_codes' and column_name = 'organization_id') then
    alter table "better_supabase"."invite_codes" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'knowledge_collection_grants' and column_name = 'organization_id') then
    alter table "better_supabase"."knowledge_collection_grants" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'knowledge_collections' and column_name = 'organization_id') then
    alter table "better_supabase"."knowledge_collections" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'knowledge_documents' and column_name = 'organization_id') then
    alter table "better_supabase"."knowledge_documents" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'legal_holds' and column_name = 'organization_id') then
    alter table "better_supabase"."legal_holds" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'memories' and column_name = 'organization_id') then
    alter table "better_supabase"."memories" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'memory_message_embeddings' and column_name = 'organization_id') then
    alter table "better_supabase"."memory_message_embeddings" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'notification_deliveries' and column_name = 'organization_id') then
    alter table "better_supabase"."notification_deliveries" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'notification_delivery_events' and column_name = 'organization_id') then
    alter table "better_supabase"."notification_delivery_events" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'notification_digests' and column_name = 'organization_id') then
    alter table "better_supabase"."notification_digests" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'notification_events' and column_name = 'organization_id') then
    alter table "better_supabase"."notification_events" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'notification_preferences' and column_name = 'organization_id') then
    alter table "better_supabase"."notification_preferences" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'notification_recipients' and column_name = 'organization_id') then
    alter table "better_supabase"."notification_recipients" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'notification_subscriptions' and column_name = 'organization_id') then
    alter table "better_supabase"."notification_subscriptions" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'organization_deletions' and column_name = 'organization_id') then
    alter table "better_supabase"."organization_deletions" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'organization_settings' and column_name = 'organization_id') then
    alter table "better_supabase"."organization_settings" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'outbox_events' and column_name = 'organization_id') then
    alter table "better_supabase"."outbox_events" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'permission_overrides' and column_name = 'organization_id') then
    alter table "better_supabase"."permission_overrides" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'prompt_labels' and column_name = 'organization_id') then
    alter table "better_supabase"."prompt_labels" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'prompt_versions' and column_name = 'organization_id') then
    alter table "better_supabase"."prompt_versions" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'rate_limit_rules' and column_name = 'organization_id') then
    alter table "better_supabase"."rate_limit_rules" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'retention_policies' and column_name = 'organization_id') then
    alter table "better_supabase"."retention_policies" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'scim_groups' and column_name = 'organization_id') then
    alter table "better_supabase"."scim_groups" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'scim_users' and column_name = 'organization_id') then
    alter table "better_supabase"."scim_users" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'sso_domains' and column_name = 'organization_id') then
    alter table "better_supabase"."sso_domains" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'sso_providers' and column_name = 'organization_id') then
    alter table "better_supabase"."sso_providers" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'support_requests' and column_name = 'organization_id') then
    alter table "better_supabase"."support_requests" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'support_sessions' and column_name = 'organization_id') then
    alter table "better_supabase"."support_sessions" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'timeline_entries' and column_name = 'organization_id') then
    alter table "better_supabase"."timeline_entries" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'usage_billed_periods' and column_name = 'organization_id') then
    alter table "better_supabase"."usage_billed_periods" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'usage_counters' and column_name = 'organization_id') then
    alter table "better_supabase"."usage_counters" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'usage_events' and column_name = 'organization_id') then
    alter table "better_supabase"."usage_events" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'usage_history' and column_name = 'organization_id') then
    alter table "better_supabase"."usage_history" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'usage_quotas' and column_name = 'organization_id') then
    alter table "better_supabase"."usage_quotas" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'webhook_deliveries' and column_name = 'organization_id') then
    alter table "better_supabase"."webhook_deliveries" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'webhook_endpoint_secrets' and column_name = 'organization_id') then
    alter table "better_supabase"."webhook_endpoint_secrets" rename column "organization_id" to "tenant_id";
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'better_supabase' and table_name = 'webhook_endpoints' and column_name = 'organization_id') then
    alter table "better_supabase"."webhook_endpoints" rename column "organization_id" to "tenant_id";
  end if;
  declare
    c record;
  begin
    for c in
      select n.nspname as schema_name, r.relname as table_name, k.conname as name
      from pg_catalog.pg_constraint k
        join pg_catalog.pg_class r on r.oid = k.conrelid
        join pg_catalog.pg_namespace n on n.oid = r.relnamespace
      where n.nspname in ('better_supabase', 'workflow') and k.contype = 'c' and k.conname !~ '^bsb_' and length(k.conname) <= 59
    loop
      execute format('alter table %I.%I rename constraint %I to %I', c.schema_name, c.table_name, c.name, 'bsb_' || c.name);
    end loop;
  end;
end
$$;
