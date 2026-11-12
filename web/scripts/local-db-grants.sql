DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'team_b_app') THEN
    CREATE ROLE team_b_app LOGIN PASSWORD 'team_b_app_local';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO team_b_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO team_b_app;
REVOKE UPDATE, DELETE ON TABLE public.audit_logs FROM team_b_app;
