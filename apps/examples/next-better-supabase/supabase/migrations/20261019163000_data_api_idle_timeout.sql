-- Role settings sit outside supabase/schemas, so the declarative diff never writes them.
alter role anon set idle_in_transaction_session_timeout = '60s';
alter role authenticated set idle_in_transaction_session_timeout = '60s';

notify pgrst, 'reload config';
